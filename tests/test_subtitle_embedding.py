import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("subtitle_embedding", Path(__file__).parents[1] / "src/scripts/python/subtitle_embedding.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SubtitleEmbeddingTests(unittest.TestCase):
    def test_query_instruction_only_applies_to_queries(self):
        self.assertEqual(module.validate_request({"texts": ["问题"]}), ["问题"])
        self.assertEqual(module.validate_request({"texts": ["问题"], "query": True}), [module.QUERY_PREFIX + "问题"])

    def test_rejects_invalid_batches(self):
        for value in [{}, {"texts": []}, {"texts": [3]}, {"texts": ["a"] * 33},
                      {"texts": ["a" * 2001]}, {"texts": ["a"], "query": "true"}]:
            with self.assertRaises(ValueError):
                module.validate_request(value)


if __name__ == "__main__":
    unittest.main()
