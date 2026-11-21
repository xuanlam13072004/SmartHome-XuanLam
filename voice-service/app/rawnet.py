"""The anti-spoof network: RawNet2-style residual 1-D CNN on raw waveforms
(architecture kept from the original system). Fixes over the original:
- stateless and thread-safe: no model object shared between profiles, loaded
  weights cached per (profile, version);
- mini-batch training with class weighting and a fixed seed (reproducible);
- weights stored as float16 in PostgreSQL (~0.5 MB) instead of files."""
from __future__ import annotations

import io
import threading
from collections import OrderedDict

import numpy as np
import torch
import torch.nn as nn


class RawNet2Block(nn.Module):
    def __init__(self, in_ch: int, out_ch: int, stride: int = 1):
        super().__init__()
        self.conv1 = nn.Conv1d(in_ch, out_ch, kernel_size=3, stride=stride, padding=1)
        self.bn1 = nn.BatchNorm1d(out_ch)
        self.conv2 = nn.Conv1d(out_ch, out_ch, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm1d(out_ch)
        self.shortcut = None
        if stride != 1 or in_ch != out_ch:
            self.shortcut = nn.Sequential(nn.Conv1d(in_ch, out_ch, kernel_size=1, stride=stride), nn.BatchNorm1d(out_ch))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        residual = x if self.shortcut is None else self.shortcut(x)
        out = torch.relu(self.bn1(self.conv1(x)))
        return torch.relu(self.bn2(self.conv2(out)) + residual)


class RawNet2AntiSpoof(nn.Module):
    def __init__(self):
        super().__init__()
        self.front = nn.Sequential(nn.Conv1d(1, 24, kernel_size=5, stride=2, padding=2), nn.BatchNorm1d(24), nn.ReLU())
        self.res = nn.Sequential(
            RawNet2Block(24, 48, stride=2),
            RawNet2Block(48, 48),
            RawNet2Block(48, 96, stride=2),
            RawNet2Block(96, 96),
            RawNet2Block(96, 128, stride=2),
        )
        self.pool = nn.AdaptiveAvgPool1d(1)
        self.head = nn.Sequential(nn.Flatten(), nn.Linear(128, 48), nn.ReLU(), nn.Dropout(0.2), nn.Linear(48, 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.head(self.pool(self.res(self.front(x))))


class RawNetBackend:
    def __init__(self, epochs: int = 24, batch_size: int = 16, cache_size: int = 64):
        self.epochs = epochs
        self.batch_size = batch_size
        self._cache: OrderedDict[object, RawNet2AntiSpoof] = OrderedDict()
        self._cache_size = cache_size
        self._lock = threading.Lock()

    def train(self, x: np.ndarray, y: np.ndarray, seed: int) -> tuple[bytes, dict]:
        generator = torch.Generator().manual_seed(seed)
        torch.manual_seed(seed)
        model = RawNet2AntiSpoof()
        model.train()
        inputs = torch.from_numpy(np.asarray(x, dtype=np.float32)).unsqueeze(1)
        labels = torch.from_numpy(np.asarray(y, dtype=np.float32)).unsqueeze(1)
        positives = float(labels.sum())
        pos_weight = torch.tensor([max(1.0, (len(labels) - positives) / max(positives, 1.0))])
        criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        optimizer = torch.optim.Adam(model.parameters(), lr=8e-4)
        epoch_loss, epochs = 0.0, 0
        for epochs in range(1, self.epochs + 1):
            order = torch.randperm(len(labels), generator=generator)
            total = 0.0
            for start in range(0, len(order), self.batch_size):
                idx = order[start: start + self.batch_size]
                if len(idx) < 2:  # BatchNorm needs two examples
                    continue
                optimizer.zero_grad()
                loss = criterion(model(inputs[idx]), labels[idx])
                loss.backward()
                optimizer.step()
                total += float(loss) * len(idx)
            epoch_loss = total / len(labels)
            if epoch_loss < 0.02:
                break
        model.eval()
        state = {k: (v.half() if v.is_floating_point() else v) for k, v in model.state_dict().items()}
        buffer = io.BytesIO()
        torch.save(state, buffer)
        return buffer.getvalue(), {"backend": "rawnet2", "epochs": epochs, "loss": round(epoch_loss, 5)}

    def _load(self, weights: bytes, cache_key: object) -> RawNet2AntiSpoof:
        with self._lock:
            if cache_key is not None and cache_key in self._cache:
                self._cache.move_to_end(cache_key)
                return self._cache[cache_key]
        state = torch.load(io.BytesIO(weights), map_location="cpu", weights_only=True)
        model = RawNet2AntiSpoof()
        model.load_state_dict({k: (v.float() if v.is_floating_point() else v) for k, v in state.items()})
        model.eval()
        if cache_key is not None:
            with self._lock:
                self._cache[cache_key] = model
                while len(self._cache) > self._cache_size:
                    self._cache.popitem(last=False)
        return model

    def predict(self, weights: bytes, x: np.ndarray, cache_key: object = None) -> np.ndarray:
        model = self._load(weights, cache_key)
        with torch.no_grad():
            logits = model(torch.from_numpy(np.asarray(x, dtype=np.float32)).unsqueeze(1))
        return torch.sigmoid(logits).squeeze(1).numpy().astype(np.float64)
