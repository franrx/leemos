#!/usr/bin/env python3
"""Synthesize an IPA string with a Piper voice, skipping the text-to-phoneme (espeak) step.

Used by piper.mjs for the isolated letter sounds, where a text voice would say the letter's name.
usage: piper_ipa.py MODEL.onnx IPA OUT.wav [LENGTH_SCALE]
Needs the `piper-tts` Python package (pip install piper-tts). LENGTH_SCALE > 1 stretches the sound.
"""
import sys
import wave

import numpy as np
from piper import PiperVoice, SynthesisConfig

if len(sys.argv) < 4:
    sys.exit(__doc__)
model, ipa, out = sys.argv[1:4]
length_scale = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0

voice = PiperVoice.load(model)
missing = [c for c in ipa if c not in voice.config.phoneme_id_map]
if missing:
    sys.exit("phonemes not in this voice's inventory: " + " ".join(f"{c} (U+{ord(c):04X})" for c in missing))

ids = voice.phonemes_to_ids(list(ipa))
audio = np.asarray(voice.phoneme_ids_to_audio(ids, SynthesisConfig(length_scale=length_scale))).reshape(-1)
if audio.dtype != np.int16:
    audio = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
with wave.open(out, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(voice.config.sample_rate)
    w.writeframes(audio.tobytes())
