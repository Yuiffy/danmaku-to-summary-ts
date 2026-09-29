# The base server omits vllm[audio]; pin the required decoding wheels explicitly.
FROM vllm/vllm-openai@sha256:0a51ea5b4ae2dc5d81890e5173f54203d2a3ae0cfffe51b8fd2afd4391bfd967
RUN python3 -m pip install --no-cache-dir soundfile==0.13.1 av==16.0.1 soxr==1.0.0
