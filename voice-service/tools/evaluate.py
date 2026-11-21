"""Measures how well voice verification works, for the thesis report.

Offline, on recordings (same pipeline and thresholds as the service):

    docker compose run --rm -v D:/voice-eval:/eval:ro voice-service python -m tools.evaluate /eval

    /eval/speakers/<person>/*.wav   live recordings, at least 4 per person
    /eval/spoof/<person>/*.wav      optional: replays of that person (speaker, TTS)

The first --enroll files of each person build their profile; the rest are
genuine trials, every other person's files are impostor trials and the spoof
files are replay attacks. Reports EER, and FAR/FRR at the service thresholds.

Online, from what the service recorded in the last 30 days (no audio):

    docker compose run --rm voice-service python -m tools.evaluate --from-db
"""
from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app import antispoof as sp
from app.audio import PROFILE_RULE, SPOOF_RULE, VERIFY_RULE, analyze, decode
from app.embedding import embed_speech
from app.errors import VoiceError
from app.scoring import Scores, Thresholds, as_norm, centroid, cosine, decide, fuse


def eer(genuine: list[float], impostor: list[float]) -> tuple[float, float] | None:
    """Equal error rate and the threshold where it occurs."""
    if not genuine or not impostor:
        return None
    g, i = np.asarray(genuine), np.asarray(impostor)
    best = (1.0, 0.0)
    for t in np.unique(np.concatenate([g, i])):
        frr, far = float(np.mean(g < t)), float(np.mean(i >= t))
        if abs(frr - far) < abs(best[0] - best[1]) or (abs(frr - far) == abs(best[0] - best[1]) and frr + far < sum(best)):
            best, at = (frr, far), float(t)
    return round((best[0] + best[1]) / 2, 4), round(at, 4)


def rate(values: list[bool]) -> float | None:
    return None if not values else round(float(np.mean(values)), 4)


@dataclass
class Trials:
    genuine: list[Scores] = field(default_factory=list)
    impostor: list[Scores] = field(default_factory=list)
    spoof: list[Scores] = field(default_factory=list)
    decisions: dict[str, list[bool]] = field(default_factory=lambda: {"genuine": [], "impostor": [], "spoof": []})
    skipped: int = 0


def _load(path: Path, rule):
    return analyze(decode(path.read_bytes()), rule)


def evaluate(embedder, backend: sp.Backend | None, root: Path, enroll: int = 3, cohort: np.ndarray | None = None,
             thresholds: Thresholds = Thresholds()) -> dict:
    people = {p.name: sorted(p.glob("*.wav")) for p in sorted((root / "speakers").iterdir()) if p.is_dir()}
    people = {k: v for k, v in people.items() if len(v) > enroll}
    if len(people) < 2:
        raise SystemExit("Need at least two people with more than --enroll recordings each.")
    trials = Trials()
    tests: dict[str, list] = {}
    profiles = {}
    for person, files in people.items():
        speeches = []
        for path in files[:enroll]:
            try:
                speeches.append(_load(path, PROFILE_RULE))
            except VoiceError:
                trials.skipped += 1
        if len(speeches) < 2:
            continue
        vectors = np.stack([embed_speech(embedder, s.voiced) for s in speeches])
        model = sp.train_profile(backend, [sp.best_clip(s.span) for s in speeches], []) if backend else None
        profiles[person] = (centroid(vectors), model)
        tests[person] = []
        for path in files[enroll:]:
            try:
                speech = _load(path, VERIFY_RULE)
            except VoiceError:
                trials.skipped += 1
                continue
            tests[person].append((speech, embed_speech(embedder, speech.voiced)))

    def score(person: str, speech, probe) -> tuple[Scores, bool]:
        enrolled, model = profiles[person]
        similarity = cosine(probe, enrolled)
        anti = sp.score_span(backend, model, speech.span) if model else 1.0
        s = Scores(similarity, as_norm(similarity, enrolled, probe, cohort), anti, fuse(similarity, anti, speech.snr_db),
                   speech.snr_db)
        floor = model.stats["floor"] if model else 0.0
        return s, decide(s, thresholds, floor)[0]

    for person in profiles:
        for speech, probe in tests[person]:
            s, ok = score(person, speech, probe)
            trials.genuine.append(s)
            trials.decisions["genuine"].append(ok)
        for other in profiles:
            if other == person:
                continue
            for speech, probe in tests[other]:
                s, ok = score(person, speech, probe)
                trials.impostor.append(s)
                trials.decisions["impostor"].append(ok)
        spoof_dir = root / "spoof" / person
        for path in sorted(spoof_dir.glob("*.wav")) if spoof_dir.is_dir() else []:
            try:
                speech = _load(path, SPOOF_RULE)
            except VoiceError:
                trials.skipped += 1
                continue
            s, ok = score(person, speech, embed_speech(embedder, speech.voiced))
            trials.spoof.append(s)
            trials.decisions["spoof"].append(ok)

    g, i, f = trials.genuine, trials.impostor, trials.spoof
    report = {
        "people": len(profiles),
        "trials": {"genuine": len(g), "impostor": len(i), "spoof": len(f), "skipped_files": trials.skipped},
        "speaker": {
            "cosine_eer": eer([t.similarity for t in g], [t.similarity for t in i]),
            "cosine_frr_at_threshold": rate([t.similarity < thresholds.speaker for t in g]),
            "cosine_far_at_threshold": rate([t.similarity >= thresholds.speaker for t in i]),
        },
        "system": {
            "false_reject_rate": rate([not ok for ok in trials.decisions["genuine"]]),
            "false_accept_rate": rate(trials.decisions["impostor"]),
            "spoof_accept_rate": rate(trials.decisions["spoof"]),
        },
        "thresholds": {"speaker": thresholds.speaker, "norm": thresholds.norm, "fusion": thresholds.fusion},
    }
    if cohort is not None:
        report["speaker"].update({
            "as_norm_eer": eer([t.normalized for t in g], [t.normalized for t in i]),
            "as_norm_frr_at_threshold": rate([t.normalized < thresholds.norm for t in g]),
            "as_norm_far_at_threshold": rate([t.normalized >= thresholds.norm for t in i]),
        })
    if backend is not None and f:
        report["anti_spoof"] = {"eer": eer([t.anti_spoof for t in g], [t.anti_spoof for t in f])}
    return report


def from_database(url: str, days: int = 30) -> dict:
    import psycopg

    with psycopg.connect(url) as conn:
        rows = conn.execute(
            """SELECT kind, accepted, coalesce(reason, 'accepted'), count(*)::int,
                      avg(similarity)::real, avg(anti_spoof)::real, avg(fusion)::real, avg(snr_db)::real
               FROM voice_attempts WHERE created_at > now() - make_interval(days => %s)
               GROUP BY 1, 2, 3 ORDER BY 1, 2 DESC, 3""", (days,)).fetchall()
        profiles = conn.execute("SELECT count(*)::int, count(calibrated_at)::int FROM voice_profiles").fetchone()
    return {
        "days": days, "profiles": profiles[0], "calibrated_profiles": profiles[1],
        "attempts": [{"kind": r[0], "outcome": r[2], "count": r[3], "similarity": r[4], "anti_spoof": r[5],
                      "fusion": r[6], "snr_db": r[7]} for r in rows],
    }


def as_markdown(report: dict) -> str:
    def pct(v):
        return "—" if v is None else f"{100 * v:.2f}%"

    lines = [f"Người: {report['people']} · thử thật: {report['trials']['genuine']} · "
             f"thử mạo danh: {report['trials']['impostor']} · phát lại: {report['trials']['spoof']}", "",
             "| Chỉ số | Giá trị |", "|---|---|"]
    sp_ = report["speaker"]
    if sp_.get("cosine_eer"):
        lines.append(f"| EER cosine | {pct(sp_['cosine_eer'][0])} (ngưỡng {sp_['cosine_eer'][1]}) |")
    if sp_.get("as_norm_eer"):
        lines.append(f"| EER AS-norm | {pct(sp_['as_norm_eer'][0])} (ngưỡng {sp_['as_norm_eer'][1]}) |")
    lines.append(f"| FRR cosine @ {report['thresholds']['speaker']} | {pct(sp_['cosine_frr_at_threshold'])} |")
    lines.append(f"| FAR cosine @ {report['thresholds']['speaker']} | {pct(sp_['cosine_far_at_threshold'])} |")
    if "as_norm_frr_at_threshold" in sp_:
        lines.append(f"| FRR AS-norm @ {report['thresholds']['norm']} | {pct(sp_['as_norm_frr_at_threshold'])} |")
        lines.append(f"| FAR AS-norm @ {report['thresholds']['norm']} | {pct(sp_['as_norm_far_at_threshold'])} |")
    if report.get("anti_spoof", {}).get("eer"):
        lines.append(f"| EER chống giả mạo | {pct(report['anti_spoof']['eer'][0])} |")
    system = report["system"]
    lines += [f"| Hệ thống: từ chối nhầm chủ | {pct(system['false_reject_rate'])} |",
              f"| Hệ thống: chấp nhận nhầm người lạ | {pct(system['false_accept_rate'])} |",
              f"| Hệ thống: chấp nhận bản phát lại | {pct(system['spoof_accept_rate'])} |"]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("data_dir", nargs="?", type=Path)
    parser.add_argument("--enroll", type=int, default=3)
    parser.add_argument("--cohort", default=os.environ.get("VOICE_COHORT_PATH", "/data/cohort.npy"))
    parser.add_argument("--no-antispoof", action="store_true", help="speaker check only (much faster)")
    parser.add_argument("--json", type=Path, help="also write the report as JSON")
    parser.add_argument("--from-db", action="store_true")
    args = parser.parse_args(argv)

    if args.from_db:
        from app.config import _database_url
        report = from_database(_database_url(dict(os.environ)))
        print(json.dumps(report, ensure_ascii=False, indent=2, default=str))
    else:
        if args.data_dir is None:
            parser.error("data_dir is required (or use --from-db)")
        from app.cohort import load_cohort
        from app.embedding import EcapaEmbedder

        backend = None
        if not args.no_antispoof:
            from app.rawnet import RawNetBackend
            backend = RawNetBackend()
        report = evaluate(EcapaEmbedder(os.environ.get("VOICE_MODEL_DIR", "/models/ecapa")), backend,
                          args.data_dir, args.enroll, load_cohort(args.cohort))
        print(as_markdown(report))
    if args.json:
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
