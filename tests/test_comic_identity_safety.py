import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
import ai_comic_generator as comic
from comic.prompts import format_image_reference_manifest


class ComicIdentitySafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        voice = self.root / 'host.wav'
        voice.write_bytes(b'reference fixture')
        self.highlight = self.root / 'room_recording_AI_HIGHLIGHT.txt'
        self.highlight.write_text('[Host 0.9] Good evening.\n[UNKNOWN 0.4] I moved home.', encoding='utf-8')
        self.sidecar = self.root / 'room_recording.asr_speakers.json'
        self.media = self.root / 'room_recording.flv'
        self.media.write_bytes(b'recording fixture')
        self.config = {
            'asr': {'paraformer': {'speaker_references': [{'speaker': 'Host', 'audio_path': str(voice)}]}},
            'ai': {
                'comic': {'multiReferenceImages': {'enabled': True, 'maxExtraCharacters': 3,
                                                  'minSpeechSeconds': 8, 'minSpeakerScore': .6}},
                'streamerRegistry': {
                    'host': {'displayName': 'Host', 'roomIds': ['42']},
                    'guest': {'displayName': 'Guest', 'speakerLabels': ['Guest']},
                    'other': {'displayName': 'Other', 'speakerLabels': ['Other']},
                },
                'text': {'sharedPromptCache': {'enabled': False}},
            },
            'roomSettings': {'42': {'characterDescription': 'Host character'}},
        }
        self.patch = mock.patch.object(comic, 'load_config', return_value=self.config)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def write_sidecar(self, **overrides):
        value = {
            'hostRoomId': '42', 'extraAppearedStreamerIds': ['guest'],
            'speakers': [self.speaker('Guest')],
        }
        value.update(overrides)
        if 'participantDiscovery' in value:
            value['participantDiscovery'] = self.discovery(value['participantDiscovery'])
        self.sidecar.write_text(json.dumps(value), encoding='utf-8')

    def discovery(self, fields):
        info = self.media.stat()
        return {
            'version': 1, 'source': 'session_participant_discovery', 'roomId': '42',
            'session': {'roomId': '42', 'sessionId': str(self.media),
                        'startedAt': '2026-09-12T10:00:00.000Z'},
            'binding': {'sourceMediaPath': str(self.media), 'size': info.st_size, 'mtimeMs': info.st_mtime * 1000},
            **fields,
        }

    def speaker(self, name):
        return {'label': name, 'totalSpeechSeconds': 200, 'avgScore': .88, 'maxScore': .94}

    def resolve(self):
        return comic.resolve_extra_appeared_streamers(self.config, '42', str(self.highlight), False)

    def test_id_lists_and_planned_roster_do_not_replace_acoustic_evidence(self):
        self.write_sidecar(speakers=[], constrainedToRoster=True,
                           participants=[{'streamerId': 'guest', 'appeared': True}])
        self.assertEqual(self.resolve(), [])

    def test_missing_unknown_and_nonfinite_scores_do_not_pass(self):
        for update in ({'avgScore': None}, {'maxScore': None}, {'avgScore': float('inf')},
                       {'totalSpeechSeconds': float('inf')}, {'isUnknown': True}, {'identityVerified': False}):
            with self.subTest(update=update):
                self.write_sidecar(speakers=[{**self.speaker('Guest'), **update}])
                self.assertEqual(self.resolve(), [])

    def test_participant_fallback_obeys_required_roster(self):
        self.config['ai']['comic']['multiReferenceImages']['requirePlannedRosterForAppearedCharacters'] = True
        self.write_sidecar(extraAppearedStreamerIds=[], constrainedToRoster=False,
                           participants=[{'streamerId': 'guest', 'appeared': True}])
        self.assertEqual(self.resolve(), [])

    def test_participant_fallback_adds_other_confirmed_voice_after_first(self):
        self.write_sidecar(speakers=[self.speaker('Guest'), self.speaker('Other')],
                           participants=[{'streamerId': 'other', 'appeared': True}])
        self.assertEqual([row['id'] for row in self.resolve()], ['guest', 'other'])

    def test_confirmed_audio_still_needs_event_evidence_for_live_interaction(self):
        self.write_sidecar()
        extras = self.resolve()
        self.assertEqual(extras[0]['_comicPresence'], 'audio_confirmed')
        prompt = comic.build_comic_generation_prompt('Host', self.highlight.read_text(), '42', extras)
        self.assertIn('音频身份依据', prompt)
        self.assertIn('观看视频/回放中的声音不代表连麦', prompt)

    def test_live_confirmed_collaboration_keeps_both_participants(self):
        self.write_sidecar(extraAppearedStreamerIds=['guest', 'other'],
                           speakers=[self.speaker('Guest'), self.speaker('Other')],
                           participantDiscovery={'confirmedParticipantIds': ['guest', 'other']})
        extras = self.resolve()
        self.assertEqual([row['id'] for row in extras], ['guest', 'other'])
        self.assertTrue(all(row['_comicPresence'] == 'live_confirmed' for row in extras))
        prompt = comic.build_comic_generation_prompt('Host', 'We play together.', '42', extras)
        self.assertIn('另有本场参与证据', prompt)
        self.assertIn('共同事件', prompt)

    def test_watched_absent_and_preview_people_do_not_become_live_cast(self):
        for status in ('watching', 'watched_content', 'external_audio', 'character', 'absent', 'preview_only', 'mention_only'):
            with self.subTest(status=status):
                self.write_sidecar(participantDiscovery={'confirmedParticipantIds': ['guest'], 'participants': [
                    {'streamerId': 'guest', 'status': status},
                ]})
                self.assertEqual(self.resolve(), [])

    def test_visual_or_title_candidate_needs_voice_evidence(self):
        self.write_sidecar(extraAppearedStreamerIds=[], speakers=[], participantDiscovery={
            'candidateStreamerIds': ['guest'], 'plannedParticipantIds': ['guest'],
            'participants': [{'streamerId': 'guest', 'status': 'candidate', 'sources': ['cover', 'frame', 'live_title']}],
        })
        self.assertEqual(self.resolve(), [])

    def test_discovery_watching_relation_withholds_live_role_without_erasing_whole_session_voice(self):
        self.write_sidecar(participantDiscovery={'mentions': [{'streamerId': 'guest', 'relation': 'watching'}]})
        extras = self.resolve()
        self.assertEqual(extras[0]['_comicPresence'], 'unresolved_presence')
        prompt = comic.build_comic_generation_prompt('Host', 'We watched Guest before chatting.', '42', extras)
        self.assertIn('到场未确认', prompt)
        self.assertIn('不能据某个观看片段断言整场未参与', prompt)

    def test_verified_live_guest_can_also_be_mentioned_in_watched_content(self):
        self.write_sidecar(participantDiscovery={
            'confirmedParticipantIds': ['guest'],
            'mentions': [{'streamerId': 'guest', 'relation': 'watching'}],
        })
        self.assertEqual(self.resolve()[0]['_comicPresence'], 'live_confirmed')

    def test_confirmed_solo_excludes_unconfirmed_audio_guest_but_title_plan_does_not(self):
        self.write_sidecar(participantDiscovery={'mode': 'solo', 'modeStatus': 'confirmed'})
        self.assertEqual(self.resolve(), [])
        self.write_sidecar(participantDiscovery={'mode': 'solo', 'modeStatus': 'planned'})
        self.assertEqual([row['id'] for row in self.resolve()], ['guest'])

    def test_live_context_can_bind_new_presence_evidence_to_existing_voice_summary(self):
        self.write_sidecar()
        context = {'schemaVersion': 1, 'roomId': '42', 'recordingStartTime': '2026-09-12T10:00:00Z',
                   'participantDiscovery': self.discovery({'confirmedParticipantIds': ['guest']})}
        path = Path(comic.live_generation_context_path(str(self.highlight)))
        path.write_text(json.dumps(context), encoding='utf-8')
        self.assertEqual(self.resolve()[0]['_comicPresence'], 'live_confirmed')
        previous_hash = comic.hash_live_generation_context(context)
        context['participantDiscovery']['confirmedParticipantIds'] = []
        self.assertNotEqual(previous_hash, comic.hash_live_generation_context(context))

    def test_other_recording_or_unbound_context_cannot_confirm_live_presence(self):
        for patch in (
            {'roomId': 'different'},
            {'session': {'roomId': '42', 'sessionId': str(self.root / 'different.srt'), 'startedAt': '2026-09-12T10:00:00Z'}},
            {'session': {'roomId': '42', 'sessionId': str(self.root / 'room_recording.srt')}},
            {'binding': None},
        ):
            with self.subTest(patch=patch):
                self.write_sidecar(participantDiscovery=self.discovery({'confirmedParticipantIds': ['guest'], **patch}))
                self.assertEqual(self.resolve()[0]['_comicPresence'], 'audio_confirmed')

    def test_changed_media_binding_cannot_confirm_guest(self):
        media = self.root / 'room_recording.flv'
        media.write_bytes(b'original recording')
        info = media.stat()
        self.write_sidecar(participantDiscovery={
            'confirmedParticipantIds': ['guest'],
            'session': {'roomId': '42', 'sessionId': str(media), 'startedAt': '2026-09-12T10:00:00Z'},
            'binding': {'sourceMediaPath': str(media), 'size': info.st_size, 'mtimeMs': info.st_mtime * 1000},
        })
        self.assertEqual(self.resolve()[0]['_comicPresence'], 'live_confirmed')
        media.write_bytes(b'replaced recording with different bytes')
        self.assertEqual(self.resolve()[0]['_comicPresence'], 'audio_confirmed')

    def test_wrong_room_sidecar_cannot_add_guest(self):
        self.write_sidecar(hostRoomId='different')
        self.assertEqual(self.resolve(), [])

    def test_sanitizing_keeps_each_speaker_and_unknown_boundaries(self):
        source = '[Host 0.95] I play.\n[Guest 0.9] I was ill.\n[UNKNOWN 0.4] I moved.\n[SPEAKER_01 0.8] I quit.'
        result = comic.sanitize_highlight_for_comic_script(source, '42', self.config)
        for label in ('Host', 'Guest', 'UNKNOWN', 'SPEAKER_01'):
            self.assertIn(f'[{label}]', result)
        self.assertNotIn('0.95', result)

    def test_custom_script_without_placeholder_still_enforces_identity(self):
        self.config['roomSettings']['42']['customPrompts'] = {'comicScript': '画一张图：{highlight_content}'}
        prompt = comic.build_comic_generation_prompt('Host', '[UNKNOWN] I was ill.', '42')
        self.assertIn('人物事实边界', prompt)
        self.assertIn('不能因为只有一位已知主播', prompt)
        self.assertIn('[UNKNOWN] I was ill.', prompt)

    def test_cached_script_and_custom_image_cannot_skip_identity_rules(self):
        self.config['roomSettings']['42']['customPrompts'] = {'comicImage': '绘制：{comic_content}'}
        prompt, _, _ = comic.build_comic_prompt('[UNKNOWN] I moved.', room_id='42', existing_comic='Host thinks about moving.')
        self.assertIn('人物事实边界', prompt)
        self.assertIn('UNKNOWN', prompt)
        self.assertIn('不能代替语音归属', prompt)

    def test_mentions_in_extra_reference_list_never_become_confirmed_speakers(self):
        context = comic.build_comic_identity_context('Guest was mentioned.', '42', self.config,
            appeared_streamers=[{'id': 'guest', 'displayName': 'Guest', '_comicReferenceReason': 'mentioned'}])
        self.assertEqual(context['appeared'], [])
        self.assertEqual([row['id'] for row in context['mentions']], ['guest'])

    def test_image_manifest_distinguishes_mentions_from_live_participants(self):
        prompt = format_image_reference_manifest([{'role': 'mentioned_streamer', 'displayName': 'Guest'}, {'role': 'cover'}])
        self.assertIn('仅被提及，不代表到场', prompt)
        self.assertIn('不能参与本场现场互动', prompt)
        self.assertIn('封面人物不是本场参与者证明', prompt)

    def test_fallback_does_not_reassign_guest_and_unknown_to_host(self):
        script = comic.build_local_fallback_comic_script('[Guest] I was ill yesterday.\n[UNKNOWN] I moved to another city.', '25788785')
        self.assertIn('[Guest] I was ill', script)
        self.assertIn('[UNKNOWN] I moved', script)
        self.assertNotIn('岁己在直播间里', script)
        self.assertIn('不转为房主经历', script)

    def configure_automatic_cast(self):
        settings = self.config['ai']['comic']['multiReferenceImages']
        settings.update({'enabled': False, 'discoveryEnabled': True, 'allowedExtraStreamerIds': ['guest'],
                         'maxExtraCharacters': 2, 'maxTotalImages': 4})
        for person_id, name in [('host', 'Host'), ('mofu', '犬绒Mofu'), ('guest', 'Guest'),
                                ('other', 'Other'), ('fourth', 'Fourth'), ('unrelated', 'Unrelated')]:
            image = self.root / f'{person_id}.png'
            image.write_bytes(b'image fixture')
            self.config['ai']['streamerRegistry'].setdefault(person_id, {'displayName': name, 'speakerLabels': [name]})
            self.config['ai']['streamerRegistry'][person_id].update({
                'referenceImages': [str(image)], 'characterDescription': f'{name} character reference',
            })
        self.config['roomSettings']['42']['referenceImage'] = str(self.root / 'host.png')

    def automatic_discovery(self, ids, mode='multi', status='candidate'):
        names = self.config['ai']['streamerRegistry']
        return {'mode': mode, 'modeStatus': status, 'candidateStreamerIds': ids,
                'participants': [{'streamerId': key, 'displayName': names[key]['displayName'], 'status': status} for key in ids]}

    def test_discovery_candidate_plus_voice_reaches_script_images_and_description(self):
        self.configure_automatic_cast()
        self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[self.speaker('犬绒Mofu')],
                           participantDiscovery=self.automatic_discovery(['mofu']))
        script_cast = self.resolve()
        final_cast = comic.resolve_image_prompt_extra_streamers(self.config, '42', str(self.highlight), 'The group plays together.')
        images = comic.collect_all_images('42', str(self.highlight), extra_streamers=final_cast)
        self.assertEqual([row['id'] for row in script_cast], ['mofu'])
        self.assertEqual([row['id'] for row in final_cast], ['mofu'])
        self.assertEqual([Path(image).name for image in images], ['host.png', 'mofu.png'])
        self.assertIn('犬绒Mofu character reference', comic.get_multi_character_description('42', script_cast))
        self.assertEqual(script_cast[0]['_comicPresence'], 'audio_confirmed')
        self.assertFalse(self.config['ai']['comic']['multiReferenceImages']['enabled'])

    def test_discovery_without_voice_cannot_use_mention_path_to_add_character(self):
        self.configure_automatic_cast()
        self.highlight.write_text('Guest and 犬绒Mofu are mentioned in the schedule.', encoding='utf-8')
        self.write_sidecar(extraAppearedStreamerIds=['mofu', 'guest'], speakers=[],
                           participantDiscovery=self.automatic_discovery(['mofu', 'guest']))
        self.assertEqual(comic.resolve_extra_appeared_streamers(self.config, '42', str(self.highlight)), [])
        final_cast = comic.resolve_image_prompt_extra_streamers(self.config, '42', str(self.highlight), 'Guest and 犬绒Mofu play.')
        self.assertEqual(final_cast, [])
        self.assertEqual([Path(image).name for image in comic.collect_all_images('42', str(self.highlight), extra_streamers=final_cast)], ['host.png'])

    def test_solo_unknown_and_disabled_discovery_keep_original_allowlist(self):
        self.configure_automatic_cast()
        self.config['ai']['comic']['multiReferenceImages']['enabled'] = True
        for mode, enabled in [('solo', True), ('unknown', True), ('multi', False)]:
            with self.subTest(mode=mode, enabled=enabled):
                self.config['ai']['comic']['multiReferenceImages']['discoveryEnabled'] = enabled
                self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[self.speaker('犬绒Mofu')],
                                   participantDiscovery=self.automatic_discovery(['mofu'], mode))
                self.assertEqual(self.resolve(), [])

    def test_discovery_does_not_open_unrelated_reference_bank_id(self):
        self.configure_automatic_cast()
        self.write_sidecar(extraAppearedStreamerIds=['unrelated', 'mofu'],
                           speakers=[self.speaker('Unrelated'), self.speaker('犬绒Mofu')],
                           participantDiscovery=self.automatic_discovery(['mofu']))
        self.assertEqual([row['id'] for row in self.resolve()], ['mofu'])
        self.config['ai']['comic']['multiReferenceImages']['enabled'] = True
        self.assertEqual([row['id'] for row in self.resolve()], ['mofu'])

    def test_five_person_discovery_keeps_four_guests_through_old_image_budget(self):
        self.configure_automatic_cast()
        ids = ['mofu', 'guest', 'other', 'fourth']
        self.write_sidecar(extraAppearedStreamerIds=ids[:2], speakers=[
            self.speaker(self.config['ai']['streamerRegistry'][key]['displayName']) for key in ids
        ], participantDiscovery=self.automatic_discovery(ids, status='planned'))
        script_cast = self.resolve()
        self.assertEqual({row['id'] for row in script_cast}, set(ids))
        final_cast = comic.resolve_image_prompt_extra_streamers(self.config, '42', str(self.highlight), 'All four guests speak with the host.')
        self.assertEqual({row['id'] for row in final_cast}, set(ids))
        images = comic.collect_all_images('42', str(self.highlight), extra_streamers=final_cast, max_total_images=4)
        self.assertEqual({Path(image).name for image in images}, {'host.png', *(f'{key}.png' for key in ids)})

    def test_auto_cast_remains_capped_at_four_guests(self):
        self.configure_automatic_cast()
        ids = ['mofu', 'guest', 'other', 'fourth', 'unrelated']
        self.write_sidecar(extraAppearedStreamerIds=ids, speakers=[
            self.speaker(self.config['ai']['streamerRegistry'][key]['displayName']) for key in ids
        ], participantDiscovery=self.automatic_discovery(ids, status='confirmed'))
        self.assertEqual(len(self.resolve()), 4)

    def test_auto_cast_still_requires_host_reference_and_voice_thresholds(self):
        self.configure_automatic_cast()
        discovery = self.automatic_discovery(['mofu'])
        self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[{**self.speaker('犬绒Mofu'), 'avgScore': .2}], participantDiscovery=discovery)
        self.assertEqual(self.resolve(), [])
        self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[self.speaker('犬绒Mofu')],
                           participants=[{'streamerId': 'mofu', 'appeared': False}], participantDiscovery=discovery)
        self.assertEqual(self.resolve(), [])
        self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[self.speaker('犬绒Mofu')], participantDiscovery=discovery)
        self.config['asr']['paraformer']['speaker_references'] = []
        self.assertEqual(self.resolve(), [])

    def test_auto_cast_cannot_be_enabled_by_other_session_discovery(self):
        self.configure_automatic_cast()
        discovery = {**self.automatic_discovery(['mofu']), 'roomId': 'different'}
        self.write_sidecar(extraAppearedStreamerIds=['mofu'], speakers=[self.speaker('犬绒Mofu')], participantDiscovery=discovery)
        self.assertEqual(self.resolve(), [])
        self.assertFalse(comic.get_multi_reference_config(self.config, '42', str(self.highlight))['enabled'])


if __name__ == '__main__':
    unittest.main()
