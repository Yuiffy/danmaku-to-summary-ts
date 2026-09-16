import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src/scripts'))
from comic.text_client import run_node_text_generation, shared_output_options


class SharedLiveOutputTest(unittest.TestCase):
    def config(self):
        return {'ai':{'roomSettings':{'1':{'fullLiveContextExperiment':{'enabled':True,'tasks':['goodnight','summary','comic'],
            'sharedOutputCache':True,'replySummary':{'enabled':True}}}}}}

    def test_only_paired_complete_source_enables_envelope(self):
        config=self.config()
        self.assertEqual(shared_output_options(config,'1'),{'shared_output_task':'comic'})
        self.assertEqual(shared_output_options(config,'2'),{})
        experiment=config['ai']['roomSettings']['1']['fullLiveContextExperiment']
        experiment['replySummary']['sharedMaterial']={'enabled':True}
        self.assertEqual(shared_output_options(config,'1'),{})
        experiment['replySummary']['sharedMaterial']['enabled']=False
        experiment['enabled']=False
        self.assertEqual(shared_output_options(config,'1'),{})

    def test_cli_flag_and_hash_cover_the_unwrapped_comic(self):
        script='Panel one: original facts.\nPanel two: original reaction.\n{"kind":"reference","timestampsSeconds":[20]}'
        meta={'textSha256':hashlib.sha256(script.encode('utf-8')).hexdigest(),'attempts':[{'promptTokens':100,'completionTokens':80}]}
        completed=subprocess.CompletedProcess([],0,stdout=script.encode(),stderr=('[[TEXT_GENERATION_META]] '+json.dumps(meta)).encode())
        with patch('comic.text_client.shutil.which',return_value='node'), patch('comic.text_client.os.path.exists',return_value=True), patch('comic.text_client.subprocess.run',return_value=completed) as run:
            result=run_node_text_generation('facts','/workspace/ai_text_generator.js',{},100,lambda text:text==script,log=lambda *args:None,shared_output_task='comic')
        self.assertTrue(result['ok'])
        self.assertEqual(result['text'],script)
        args=run.call_args.args[0]
        self.assertEqual(args[args.index('--shared-output-task')+1],'comic')
        self.assertEqual(result['metadata']['attempts'],meta['attempts'])

    def test_no_flag_on_ordinary_calls(self):
        completed=subprocess.CompletedProcess([],0,stdout=b'ordinary script',stderr=b'')
        with patch('comic.text_client.shutil.which',return_value='node'), patch('comic.text_client.os.path.exists',return_value=True), patch('comic.text_client.subprocess.run',return_value=completed) as run:
            run_node_text_generation('facts','/workspace/ai_text_generator.js',{},None,lambda text:True,log=lambda *args:None)
        self.assertNotIn('--shared-output-task',run.call_args.args[0])


if __name__=='__main__':
    unittest.main()
