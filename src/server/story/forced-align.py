"""Align known Piper narration with Whisper cross-attention/DTW, not guessed spacing."""
import argparse
import difflib
import json
import math
import re
import unicodedata
from pathlib import Path


def alignment_text(words):
    # Case has no acoustic duration. Keep display text in the caller and avoid
    # treating uppercase emphasis as an improbable alternate spoken token.
    return ' ' + ' '.join(word.lower() if len(word) > 1 and word.isupper() else word for word in words)


def recognized_span(word, start, end, recognized, lower, upper):
    normal = lambda text: re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', text).lower())
    candidates = [(item['start'], item['end']) for item in recognized
                  if normal(word) and normal(word) == normal(item['word'])
                  and lower <= item['start'] < item['end'] <= upper
                  and abs(item['start'] - start) <= 0.08 and abs(item['end'] - end) <= 0.08]
    return candidates[0] if len(candidates) == 1 else None


def recognition_support(word, start, end, recognized):
    # Token likelihood measures text prediction, not alignment confidence.
    # Unusual casing can have low likelihood even when independent ASR heard
    # that exact word. Require substantial overlap with its real ASR span.
    normal = lambda text: re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', text).lower())
    return end > start and any(
        normal(word) == normal(item['word']) and normal(word) and
        min(end, item['end']) - max(start, item['start']) >= (end - start) * 0.5
        for item in recognized
    )


def align(data, model_name, language):
    import numpy as np
    import torch
    import whisper
    from whisper.audio import SAMPLE_RATE, HOP_LENGTH, N_FRAMES, log_mel_spectrogram, pad_or_trim
    from whisper.tokenizer import get_tokenizer
    from whisper.timing import find_alignment, merge_punctuations

    torch.set_num_threads(4)
    audio = whisper.load_audio(data['wavFile'])
    duration = len(audio) / SAMPLE_RATE
    if duration <= 0 or not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.00001:
        raise ValueError('No supported speech audio')
    words = re.findall(r'\S+', data['script'])
    recognized = [w for w in data['recognized'] if math.isfinite(w['start']) and math.isfinite(w['end']) and 0 <= w['start'] < w['end'] <= duration + 0.05]
    normal = lambda text: re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', text).lower())
    anchors = []
    for block in difflib.SequenceMatcher(None, [normal(w) for w in words], [normal(w['word']) for w in recognized], autojunk=False).get_matching_blocks():
        anchors.extend((block.a + i, block.b + i) for i in range(block.size))
    # ASR is used only for supported window boundaries. Final word times come
    # from attention to the actual audio while conditioning on the exact text.
    if len(anchors) < max(1, math.ceil(len(words) * 0.75)):
        raise ValueError('Insufficient speech anchors for text alignment')
    cuts = [(0, 0.0)]
    index, time = 0, 0.0
    while duration - time > 27:
        candidates = [(i, j) for i, j in anchors if i > index and j > 0 and time + 8 < recognized[j]['start'] < time + 24]
        preferred = [(i, j) for i, j in candidates if re.search(r'[.!?]["\u201d\u2019]?$', words[i - 1]) and recognized[j]['start'] - recognized[j - 1]['end'] > 0.08]
        if not candidates:
            raise ValueError('No supported audio window boundary')
        index, j = (preferred or candidates)[-1]
        time = (recognized[j - 1]['end'] + recognized[j]['start']) / 2
        cuts.append((index, time))
    cuts.append((len(words), duration))
    model = whisper.load_model(model_name, device='cpu')
    tokenizer = get_tokenizer(model.is_multilingual, num_languages=model.num_languages, language=language, task='transcribe')
    output = []
    previous = 0.0
    for (left, start), (right, end) in zip(cuts, cuts[1:]):
        part = audio[round(start * SAMPLE_RATE):round(end * SAMPLE_RATE)]
        tokens = tokenizer.encode(alignment_text(words[left:right]))
        if len(tokens) + len(tokenizer.sot_sequence) + 2 >= model.dims.n_text_ctx:
            raise ValueError('Narration exceeds the alignment token window')
        mel = pad_or_trim(log_mel_spectrogram(part, model.dims.n_mels), N_FRAMES).to(model.device)
        alignment = find_alignment(model, tokenizer, tokens, mel, math.ceil(len(part) / HOP_LENGTH))
        merge_punctuations(alignment, '"\'“¿([{-', '"\'.。,，!！?？:：”)]}、')
        for position, word in enumerate(alignment):
            # Punctuation has no spoken span; original punctuation is restored
            # by complete-script validation in the caller.
            if not re.search(r'\w', word.word):
                continue
            word_start, word_end = float(word.start + start), min(duration, float(word.end + start))
            if word_end == word_start:
                following = next((float(item.start + start) for item in alignment[position + 1:] if re.search(r'\w', item.word)), end)
                recovered = recognized_span(word.word, word_start, word_end, recognized, previous, following)
                if recovered:
                    word_start, word_end = recovered
            probability = float(word.probability)
            supported = recognition_support(word.word, word_start, word_end, recognized)
            samples = audio[round(word_start * SAMPLE_RATE):round(word_end * SAMPLE_RATE)]
            if not all(math.isfinite(v) for v in (word_start, word_end, probability)) or word_start < previous - 0.001 or word_end <= word_start or (probability < 0.01 and not supported) or len(samples) == 0 or np.sqrt(np.mean(samples ** 2)) < 0.00001:
                raise ValueError('Unsupported word timing or speech confidence')
            output.append({'word': word.word, 'start': word_start, 'end': word_end, 'probability': probability, 'supportedByRecognition': bool(supported)})
            previous = word_end
    return {'words': output}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--language', required=True)
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text(encoding='utf8'))
    result = align(data, args.model, args.language)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding='utf8')
