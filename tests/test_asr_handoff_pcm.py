from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/scripts/python'))
from asr_handoff_checkpoint import aligned_pcm, align_pcm_tail, probe_audio_end, read_pcm


class HandoffPcmTests(unittest.TestCase):
    def test_small_container_tail_is_zero_padded_without_altering_decoded_samples(self):
        with tempfile.TemporaryDirectory() as directory:
            pcm = Path(directory) / 'audio.f32'
            original = b'\x00\x00\x80\x3f' * 16000
            pcm.write_bytes(original)
            with patch('sensevoice_runtime.log_progress') as log:
                align_pcm_tail(pcm, 1.434)
            self.assertEqual(pcm.read_bytes(), original + b'\0' * (6944 * 4))
            self.assertEqual(len(read_pcm(pcm, 1, .434)), 6944)
            log.assert_called_once()

    def test_large_shortfall_empty_or_partial_sample_is_rejected_without_padding(self):
        for content, duration in ((b'\0' * 64000, 1.501), (b'', .1), (b'\0' * 64001, 1)):
            with self.subTest(duration=duration), tempfile.TemporaryDirectory() as directory:
                pcm = Path(directory) / 'audio.f32'
                pcm.write_bytes(content)
                with self.assertRaisesRegex(ValueError, 'Aligned audio ended early'):
                    align_pcm_tail(pcm, duration)
                self.assertEqual(pcm.read_bytes(), content)

    def test_complete_or_longer_audio_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            pcm = Path(directory) / 'audio.f32'
            original = b'\0' * 64000
            pcm.write_bytes(original)
            align_pcm_tail(pcm, 1)
            align_pcm_tail(pcm, .9)
            self.assertEqual(pcm.read_bytes(), original)

    def test_verified_video_tail_preserves_audio_and_pads_only_after_audio_eof(self):
        with tempfile.TemporaryDirectory() as directory:
            pcm = Path(directory) / 'audio.f32'
            original = b'\x00\x00\x80\x3f' * 16000
            pcm.write_bytes(original)
            with patch('sensevoice_runtime.log_progress') as log:
                align_pcm_tail(pcm, 1.838, audio_end=1.048)
            self.assertEqual(pcm.read_bytes(), original + b'\0' * (13408 * 4))
            log.assert_called_once()

    def test_audio_packets_beyond_decoded_pcm_still_reject_truncated_audio(self):
        for audio_end in (1.501, -1, float('nan'), float('inf'), 3):
            with self.subTest(audio_end=audio_end), tempfile.TemporaryDirectory() as directory:
                pcm = Path(directory) / 'audio.f32'
                original = b'\0' * 64000
                pcm.write_bytes(original)
                with self.assertRaisesRegex(ValueError, 'Aligned audio ended early'):
                    align_pcm_tail(pcm, 1.838, audio_end=audio_end)
                self.assertEqual(pcm.read_bytes(), original)

    def test_long_tail_is_probed_and_decode_uses_the_same_audio_track(self):
        for tail, expected_probes in ((.434, 0), (.838, 1)):
            with self.subTest(tail=tail), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / 'recording.flv'
                source.touch()
                def decode(args, **kwargs):
                    self.assertEqual(args[args.index('-map') + 1], '0:a:0')
                    Path(args[-1]).write_bytes(b'\0' * 64000)
                with patch('asr_handoff_checkpoint.subprocess.run', side_effect=decode), \
                     patch('asr_handoff_checkpoint.probe_audio_end', return_value=1.048) as probe, \
                     patch('sensevoice_runtime.log_progress'):
                    with aligned_pcm(source, 1 + tail) as pcm:
                        self.assertEqual(Path(pcm).stat().st_size, round((1 + tail) * 16000) * 4)
                self.assertEqual(probe.call_count, expected_probes)
                self.assertFalse(Path(pcm).exists())

    def test_tail_probe_reads_to_eof_and_rejects_missing_or_invalid_packet_evidence(self):
        packets = [{'pts_time': '17028.916', 'duration_time': '.021'},
                   {'pts_time': '17028.895', 'duration_time': '.021'}]
        with patch('asr_handoff_checkpoint.subprocess.run', return_value=Mock(
                stdout=json.dumps({'packets': packets}))) as run:
            self.assertAlmostEqual(probe_audio_end('recording.flv', 17028.889), 17028.937)
            args = run.call_args.args[0]
            self.assertEqual(args[args.index('-select_streams') + 1], 'a:0')
            self.assertEqual(args[args.index('-read_intervals') + 1], '17023.889000%')
            self.assertTrue(run.call_args.kwargs['check'])
        for invalid in ([], [{'pts_time': 'nan', 'duration_time': '.021'}],
                        [{'pts_time': '1', 'duration_time': '-.1'}]):
            with self.subTest(invalid=invalid), patch('asr_handoff_checkpoint.subprocess.run',
                    return_value=Mock(stdout=json.dumps({'packets': invalid}))):
                with self.assertRaises(ValueError):
                    probe_audio_end('recording.flv', 1)
        with patch('asr_handoff_checkpoint.subprocess.run',
                   side_effect=subprocess.CalledProcessError(1, 'ffprobe')):
            with self.assertRaises(subprocess.CalledProcessError):
                probe_audio_end('recording.flv', 1)


if __name__ == '__main__':
    unittest.main()
