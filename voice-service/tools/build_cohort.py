"""Builds the AS-norm cohort: embeddings of many other people's voices.

    docker compose run --rm -v D:/vivos/train/waves:/cohort-audio:ro voice-service \
        python -m tools.build_cohort /cohort-audio --out /data/cohort.npy

AUDIO_DIR holds one folder per speaker with WAV files (e.g. the VIVOS
corpus: train/waves/<speaker>/*.wav). Restart voice-service afterwards.
Use speakers who are NOT users of the system; a few hundred embeddings from
50+ speakers is enough."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np

from app.audio import VERIFY_RULE, analyze, decode
from app.embedding import embed_speech
from app.errors import VoiceError


def speaker_files(root: Path) -> dict[str, list[Path]]:
    folders = sorted(p for p in root.iterdir() if p.is_dir())
    if folders:
        return {f.name: sorted(f.glob("*.wav")) for f in folders}
    return {p.stem: [p] for p in sorted(root.glob("*.wav"))}


def build(embedder, root: Path, per_speaker: int, limit: int) -> tuple[np.ndarray, dict]:
    vectors, used, skipped = [], {}, 0
    for speaker, files in speaker_files(root).items():
        for path in files[:per_speaker]:
            if len(vectors) >= limit:
                break
            try:
                speech = analyze(decode(path.read_bytes()), VERIFY_RULE)
            except VoiceError:
                skipped += 1
                continue
            vectors.append(embed_speech(embedder, speech.voiced))
            used[speaker] = used.get(speaker, 0) + 1
    return np.stack(vectors).astype(np.float32) if vectors else np.zeros((0, 192), np.float32), {
        "speakers": len(used), "embeddings": len(vectors), "skipped": skipped}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio_dir", type=Path)
    parser.add_argument("--out", default=os.environ.get("VOICE_COHORT_PATH", "/data/cohort.npy"))
    parser.add_argument("--per-speaker", type=int, default=10)
    parser.add_argument("--max", type=int, default=3000)
    args = parser.parse_args(argv)

    from app.embedding import EcapaEmbedder

    cohort, info = build(EcapaEmbedder(os.environ.get("VOICE_MODEL_DIR", "/models/ecapa")),
                         args.audio_dir, args.per_speaker, args.max)
    print(f"{info['embeddings']} embeddings from {info['speakers']} speakers ({info['skipped']} files skipped)")
    if info["speakers"] < 50:
        print("Warning: fewer than 50 speakers, normalization will be unreliable.", file=sys.stderr)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    np.save(args.out, cohort)
    print(f"Saved {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
