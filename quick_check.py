import json
with open(r'D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_18\own_stream_fun_clips\upload_results_parallel.json', 'r', encoding='utf-8') as f:
    data = json.load(f)
for r in data:
    print(r.get('idx','?'), '|', r.get('status','?'))
