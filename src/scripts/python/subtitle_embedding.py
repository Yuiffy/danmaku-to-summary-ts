"""Offline BGE-small Chinese ONNX worker. JSON lines in/out; never executes corpus text."""
import argparse
import json
import os
from pathlib import Path
import sys

QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章："


def validate_request(value):
    texts = value.get("texts")
    if (not isinstance(texts, list) or not 1 <= len(texts) <= 32
            or any(not isinstance(text, str) or not text or len(text) > 2000 for text in texts)
            or not isinstance(value.get("query", False), bool)):
        raise ValueError("Invalid embedding request")
    return [QUERY_PREFIX + text if value.get("query") else text for text in texts]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-directory", required=True)
    args = parser.parse_args()
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    import numpy as np
    import onnxruntime as ort
    from tokenizers import Tokenizer

    directory = Path(args.model_directory)
    tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
    tokenizer.enable_truncation(max_length=512)
    tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.log_severity_level = 3
    session = ort.InferenceSession(str(directory / "onnx" / "model_quantized.onnx"),
                                   sess_options=options, providers=["CPUExecutionProvider"])
    inputs = {value.name for value in session.get_inputs()}
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        try:
            if len(line) > 256000:
                raise ValueError("Oversized request")
            texts = validate_request(json.loads(line))
            # Micro-batches cap attention allocations even for the longest chunks.
            vectors = []
            for offset in range(0, len(texts), 8):
                encoded = tokenizer.encode_batch(texts[offset:offset + 8])
                feed = {
                    "input_ids": np.array([value.ids for value in encoded], dtype=np.int64),
                    "attention_mask": np.array([value.attention_mask for value in encoded], dtype=np.int64),
                    "token_type_ids": np.array([value.type_ids for value in encoded], dtype=np.int64),
                }
                output = session.run(None, {key: value for key, value in feed.items() if key in inputs})[0]
                embeddings = output[:, 0, :].astype(np.float32)
                norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
                if embeddings.shape[1] != 512 or not np.isfinite(embeddings).all() or (norms < 1e-10).any():
                    raise ValueError("Invalid vectors")
                vectors.extend((embeddings / norms).tolist())
            print(json.dumps({"vectors": vectors}, separators=(",", ":")), flush=True)
        except Exception:
            print('{"error":"Local embedding failed"}', flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Local embedding worker unavailable", file=sys.stderr)
        sys.exit(1)
