"""Pure evidence checks; no model download or audio inference required."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('forced_align', Path(__file__).resolve().parents[1] / 'src/server/story/forced-align.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecognitionSupportTest(unittest.TestCase):
    def test_normalizes_emphasis_only_for_model_conditioning(self):
        self.assertEqual(module.alignment_text(['DO', 'NOT', 'look.', 'I', 'Reyes']), ' do not look. I Reyes')

    def test_recovers_quantized_span_only_from_nearby_recognition(self):
        recognized = [{'word': ' A', 'start': 3.74, 'end': 3.78}]
        self.assertEqual(module.recognized_span(' A', 3.78, 3.78, recognized, 3.26, 3.78), (3.74, 3.78))
        self.assertIsNone(module.recognized_span(' A', 5, 5, recognized, 3.26, 6))
        self.assertIsNone(module.recognized_span(' A', 3.78, 3.78, recognized, 3.76, 3.78))
        self.assertIsNone(module.recognized_span('The', 3.78, 3.78, recognized, 3.26, 4))

    def test_requires_matching_word_at_same_audio_position(self):
        recognized = [{'word': ' do', 'start': 25.42, 'end': 25.64}]
        self.assertTrue(module.recognition_support(' DO', 25.41, 25.65, recognized))
        self.assertFalse(module.recognition_support('go', 25.41, 25.65, recognized))
        self.assertFalse(module.recognition_support('do', 24, 24.5, recognized))
        self.assertFalse(module.recognition_support('do', 25.63, 26, recognized))
        self.assertFalse(module.recognition_support('do', 25.5, 25.5, recognized))


if __name__ == '__main__':
    unittest.main()
