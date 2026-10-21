import unittest
from src.scripts.python.speech_cut_boundary import refine_boundary


class SpeechCutBoundaryTests(unittest.TestCase):
    def decide(self, **kwargs):
        request = dict(original=10., side='end', anchor=9.9, speech=[[8.,10.35]],
                       envelope_start=7.5, rms_db=[-12.]*500)
        return refine_boundary(**(request|kwargs))

    def test_quiet_spoken_tail_is_preserved_despite_an_early_asr_end(self):
        decision = self.decide(rms_db=[-43.]*500)
        self.assertEqual(decision.status,'passed')
        self.assertAlmostEqual(decision.cut,10.51)

    def test_loud_game_audio_does_not_force_an_endless_silence_search(self):
        self.assertEqual(self.decide().cut,10.51)

    def test_breathing_handle_stops_before_the_next_utterance(self):
        decision=self.decide(speech=[[8.,10.15],[10.3,11.]])
        self.assertAlmostEqual(decision.cut,10.265)

    def test_continuous_speech_and_protected_next_shot_are_held(self):
        self.assertEqual(self.decide(speech=[[8.,13.]]).status,'needs_review')
        self.assertEqual(self.decide(upper=10.3).status,'needs_review')

    def test_start_expands_before_the_syllable_without_taking_previous_words(self):
        decision=self.decide(side='start',anchor=10.05,speech=[[8.8,9.7],[9.9,11.]])
        self.assertAlmostEqual(decision.cut,9.74)

    def test_missed_vad_and_no_pause_do_not_turn_into_false_success(self):
        self.assertEqual(self.decide(speech=[]).status,'needs_review')

    def test_handle_never_moves_inward_when_original_already_passed_next_onset(self):
        decision=self.decide(speech=[[8.,9.8],[10.02,11.]],anchor=9.7)
        self.assertEqual(decision.cut,10.)
        self.assertEqual(decision.status,'needs_review')

    def test_search_window_edge_is_not_mistaken_for_a_speech_end(self):
        decision=self.decide(speech=[[8.,10.4]],envelope_start=7.5,rms_db=[-12.]*290)
        self.assertEqual(decision.status,'needs_review')

    def test_silence_fallback_cannot_cut_before_last_word_anchor(self):
        decision=self.decide(speech=[],anchor=10.3,rms_db=[-12.]*250+[-80.]*250)
        self.assertEqual(decision.status,'passed')
        self.assertGreaterEqual(decision.cut,10.335)

    def test_protected_limits_must_be_finite(self):
        with self.assertRaises(ValueError): self.decide(upper=float('nan'))

    def test_missing_and_nonfinite_evidence_fail_closed(self):
        for update in ({'rms_db':[]},{'rms_db':[float('nan')]},{'speech':[[11.,9.]]}):
            with self.assertRaises(ValueError): self.decide(**update)


if __name__=='__main__': unittest.main()
