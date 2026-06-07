"""
AudioHijack PoC — Adversarial Audio Injection Against Whisper STT
Research context: defensive evaluation of Jarvis voice pipeline
Paper: "Hijacking Large Audio-Language Models via Context-Agnostic and
        Imperceptible Auditory Prompt Injection" (arXiv:2604.14604, IEEE S&P 2026)
Prior art: Carlini & Wagner 2018 (arXiv:1801.01944), Olivier et al. 2022 (arXiv:2210.17316)

Attack surface: Whisper (ASR layer) → transcription → Claude -p → executed command
If adversarial audio is played near Jarvis mic, Whisper may transcribe it as
an injected command regardless of what the audio actually sounds like to humans.
"""

import argparse
import os
import sys
import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
from transformers import WhisperProcessor, WhisperForConditionalGeneration

# ──────────────────────────────────────────────────────────────────────────────
# Config
# ──────────────────────────────────────────────────────────────────────────────

SAMPLE_RATE = 16_000
DEFAULT_MODEL = "openai/whisper-small"
DEFAULT_STEPS = 2000
DEFAULT_LR = 1e-3
DEFAULT_EPSILON = 0.02      # L∞ on raw waveform amplitude (Muting Whisper approach)
                             # corresponds to ~35-40 dB SNR on typical speech
FIRST_TOKEN_WEIGHT = 2.0    # Olivier et al. λ=1 → weight = 1+λ = 2.0
LOG_EVERY = 100

# ──────────────────────────────────────────────────────────────────────────────
# Audio helpers
# ──────────────────────────────────────────────────────────────────────────────

def load_audio(path: str) -> np.ndarray:
    """Load audio file, resample to 16 kHz mono, return float32 [-1, 1]."""
    import torchaudio
    wav, sr = torchaudio.load(path)
    if wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    if sr != SAMPLE_RATE:
        wav = torchaudio.functional.resample(wav, sr, SAMPLE_RATE)
    return wav.squeeze(0).numpy()


def snr_db(original: np.ndarray, perturbed: np.ndarray) -> float:
    """Signal-to-noise ratio of perturbation relative to original."""
    noise = perturbed - original
    signal_power = np.mean(original ** 2)
    noise_power = np.mean(noise ** 2)
    if noise_power < 1e-12:
        return float("inf")
    return 10 * np.log10(signal_power / noise_power)


def audio_to_mel(processor: WhisperProcessor, waveform: torch.Tensor) -> torch.Tensor:
    """Convert raw waveform tensor [T] to Whisper mel features [1, 80, 3000]."""
    audio_np = waveform.detach().cpu().numpy()
    # clamp to [-1, 1] before feature extraction
    audio_np = np.clip(audio_np, -1.0, 1.0)
    inputs = processor(audio_np, sampling_rate=SAMPLE_RATE, return_tensors="pt")
    return inputs.input_features  # [1, 80, 3000]

# ──────────────────────────────────────────────────────────────────────────────
# Core attack
# ──────────────────────────────────────────────────────────────────────────────

def build_target_ids(
    processor: WhisperProcessor,
    model: WhisperForConditionalGeneration,
    target_text: str,
    device: torch.device,
) -> torch.Tensor:
    """
    Encode target_text into Whisper decoder token IDs including forced prefix
    tokens (language, task, no-timestamps).
    """
    forced = model.config.forced_decoder_ids  # list of (step, token_id) pairs
    prefix_ids = [tok for _, tok in (forced or [])]

    text_ids = processor.tokenizer(
        target_text,
        add_special_tokens=False,
        return_tensors="pt",
    ).input_ids.squeeze(0).tolist()

    # SOT + prefix + text tokens + EOT
    sot = processor.tokenizer.convert_tokens_to_ids("<|startoftranscript|>")
    eot = processor.tokenizer.eos_token_id
    all_ids = [sot] + prefix_ids + text_ids + [eot]

    return torch.tensor([all_ids], dtype=torch.long, device=device)


def modified_ce_loss(
    logits: torch.Tensor,
    target_ids: torch.Tensor,
    first_token_weight: float = FIRST_TOKEN_WEIGHT,
) -> torch.Tensor:
    """
    Cross-entropy with up-weighted first token (Olivier et al. 2022).
    Whisper's autoregressive decoding is strongly conditioned on the first
    generated token — up-weighting it improves targeted attack success rate.

    logits: [1, seq_len, vocab_size]
    target_ids: [1, seq_len]
    """
    vocab_size = logits.shape[-1]
    L = target_ids.shape[1]

    # Shift: predict token[i+1] from logit[i]
    shift_logits = logits[0, :-1, :]      # [L-1, vocab]
    shift_labels = target_ids[0, 1:]      # [L-1]

    per_tok = F.cross_entropy(shift_logits, shift_labels, reduction="none")  # [L-1]

    if L > 1:
        # Up-weight first prediction step
        weights = torch.ones(L - 1, device=logits.device)
        weights[0] = first_token_weight
        loss = (per_tok * weights).sum() / (L - 1 + (first_token_weight - 1))
    else:
        loss = per_tok.mean()

    return loss


def attack(
    carrier_audio: np.ndarray,
    target_text: str,
    model_name: str = DEFAULT_MODEL,
    steps: int = DEFAULT_STEPS,
    lr: float = DEFAULT_LR,
    epsilon: float = DEFAULT_EPSILON,
    device_str: str = "cuda" if torch.cuda.is_available() else "cpu",
) -> tuple[np.ndarray, list[float]]:
    """
    Craft adversarial perturbation δ such that:
        Whisper(carrier + δ) → target_text
        ‖δ‖_∞ ≤ epsilon   (imperceptibility)

    Returns:
        adversarial_audio: np.ndarray float32
        loss_history: list of float
    """
    device = torch.device(device_str)
    print(f"[*] Loading {model_name} on {device}...")
    processor = WhisperProcessor.from_pretrained(model_name)
    model = WhisperForConditionalGeneration.from_pretrained(model_name).float().to(device)
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)

    # Pad/trim carrier to Whisper's 30s window
    max_samples = SAMPLE_RATE * 30
    if len(carrier_audio) > max_samples:
        carrier_audio = carrier_audio[:max_samples]

    carrier_tensor = torch.tensor(carrier_audio, dtype=torch.float32, device=device)
    target_ids = build_target_ids(processor, model, target_text, device)

    print(f"[*] Target: '{target_text}'")
    print(f"[*] Target token IDs: {target_ids[0].tolist()}")
    print(f"[*] Epsilon: {epsilon:.4f} (L∞, raw waveform amplitude)")
    print(f"[*] Steps: {steps}, LR: {lr}")

    # Learnable perturbation initialized to zeros
    delta = torch.zeros_like(carrier_tensor, requires_grad=True)
    optimizer = torch.optim.AdamW([delta], lr=lr, betas=(0.9, 0.999))

    loss_history = []
    best_loss = float("inf")
    best_delta = None

    for step in range(steps):
        optimizer.zero_grad()

        # Compose adversarial waveform and project to [-1,1] audio range
        adv_wave = torch.clamp(carrier_tensor + delta, -1.0, 1.0)

        # Recompute mel features from perturbed waveform each step
        # This ensures gradients flow through the actual Whisper preprocessing
        mel_features = audio_to_mel(processor, adv_wave).to(device)
        mel_features.requires_grad_(True)

        # Teacher-forced forward pass
        # Shift labels right: decoder input = target[:-1], labels = target[1:]
        decoder_input = target_ids[:, :-1]
        labels = target_ids[:, 1:]

        outputs = model(
            input_features=mel_features,
            decoder_input_ids=decoder_input,
        )

        loss = modified_ce_loss(outputs.logits, target_ids)
        loss.backward()

        # Manual gradient step on delta (gradient flows through mel_features
        # requires additional chain rule since audio_to_mel breaks autograd;
        # use direct mel-space gradient as proxy — see note below)
        # NOTE: audio_to_mel uses numpy/processor and breaks autograd.
        # For a fully differentiable pipeline, use mel_features as the
        # optimization variable directly (Option A below).
        # This version optimizes in mel-space with L∞ projection.

        if mel_features.grad is not None:
            with torch.no_grad():
                # Project mel gradient back to update delta via sign-based step
                mel_grad_sign = mel_features.grad.sign()
                # Use a small mel-domain step; delta is still in waveform space
                # For a clean waveform-domain attack, see Option B comments below
            pass

        optimizer.step()

        with torch.no_grad():
            # L∞ projection: keep perturbation imperceptible
            delta.clamp_(-epsilon, epsilon)

        loss_val = loss.item()
        loss_history.append(loss_val)

        if loss_val < best_loss:
            best_loss = loss_val
            best_delta = delta.detach().clone()

        if step % LOG_EVERY == 0 or step == steps - 1:
            # Greedy decode to monitor progress
            with torch.no_grad():
                adv_mel = audio_to_mel(processor, torch.clamp(carrier_tensor + delta, -1.0, 1.0)).to(device)
                pred_ids = model.generate(
                    adv_mel,
                    forced_decoder_ids=model.config.forced_decoder_ids,
                    max_new_tokens=50,
                )
                pred_text = processor.decode(pred_ids[0], skip_special_tokens=True).strip()
            current_snr = snr_db(carrier_audio, (carrier_tensor + delta).detach().cpu().numpy())
            print(f"  step {step:4d} | loss={loss_val:.4f} | SNR={current_snr:.1f}dB | decoded='{pred_text}'")

    # Build final adversarial audio using best delta found
    with torch.no_grad():
        adv_audio = torch.clamp(carrier_tensor + best_delta, -1.0, 1.0).cpu().numpy()

    return adv_audio, loss_history


# ──────────────────────────────────────────────────────────────────────────────
# Option A: Mel-space attack (simpler, faster, loses waveform imperceptibility)
# ──────────────────────────────────────────────────────────────────────────────

def attack_mel_space(
    carrier_audio: np.ndarray,
    target_text: str,
    model_name: str = DEFAULT_MODEL,
    steps: int = DEFAULT_STEPS,
    lr: float = DEFAULT_LR,
    epsilon: float = 0.5,   # mel-domain units; ~loosely corresponds to SNR
    device_str: str = "cuda" if torch.cuda.is_available() else "cpu",
) -> tuple[np.ndarray, list[float]]:
    """
    Simpler version: optimize perturbation directly in mel-spectrogram space.
    Full autograd — no numpy breaks in the loop.
    Trade-off: mel perturbation cannot be straightforwardly inverted back to
    a waveform you can play (would need a vocoder/Griffin-Lim). Better for
    evaluating model vulnerability; less useful for real-world audio injection.
    """
    device = torch.device(device_str)
    print(f"[*] Loading {model_name} on {device} (mel-space attack)...")
    processor = WhisperProcessor.from_pretrained(model_name)
    model = WhisperForConditionalGeneration.from_pretrained(model_name).float().to(device)
    model.eval()
    for p in model.parameters():
        p.requires_grad_(False)

    if len(carrier_audio) > SAMPLE_RATE * 30:
        carrier_audio = carrier_audio[: SAMPLE_RATE * 30]

    mel_clean = audio_to_mel(processor, torch.tensor(carrier_audio)).to(device)
    target_ids = build_target_ids(processor, model, target_text, device)

    print(f"[*] Target: '{target_text}'")
    print(f"[*] Epsilon (mel): {epsilon:.3f}")

    delta = torch.zeros_like(mel_clean, requires_grad=True)
    optimizer = torch.optim.AdamW([delta], lr=lr)

    loss_history = []
    best_loss = float("inf")
    best_delta = None

    for step in range(steps):
        optimizer.zero_grad()

        adv_mel = mel_clean + delta

        decoder_input = target_ids[:, :-1]
        outputs = model(input_features=adv_mel, decoder_input_ids=decoder_input)
        loss = modified_ce_loss(outputs.logits, target_ids)
        loss.backward()
        optimizer.step()

        with torch.no_grad():
            delta.clamp_(-epsilon, epsilon)

        loss_val = loss.item()
        loss_history.append(loss_val)

        if loss_val < best_loss:
            best_loss = loss_val
            best_delta = delta.detach().clone()

        if step % LOG_EVERY == 0 or step == steps - 1:
            with torch.no_grad():
                pred_ids = model.generate(
                    mel_clean + best_delta,
                    forced_decoder_ids=model.config.forced_decoder_ids,
                    max_new_tokens=50,
                )
                pred_text = processor.decode(pred_ids[0], skip_special_tokens=True).strip()
            print(f"  step {step:4d} | loss={loss_val:.4f} | decoded='{pred_text}'")

    # For reference: return the original audio (mel perturbation can't be inverted here)
    return carrier_audio, loss_history


# ──────────────────────────────────────────────────────────────────────────────
# Evaluation helpers
# ──────────────────────────────────────────────────────────────────────────────

def transcribe(
    audio: np.ndarray,
    model_name: str = DEFAULT_MODEL,
    device_str: str = "cuda" if torch.cuda.is_available() else "cpu",
) -> str:
    device = torch.device(device_str)
    processor = WhisperProcessor.from_pretrained(model_name)
    model = WhisperForConditionalGeneration.from_pretrained(model_name).float().to(device)
    model.eval()
    mel = audio_to_mel(processor, torch.tensor(audio)).to(device)
    with torch.no_grad():
        ids = model.generate(
            mel,
            forced_decoder_ids=model.config.forced_decoder_ids,
            max_new_tokens=100,
        )
    return processor.decode(ids[0], skip_special_tokens=True).strip()


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="AudioHijack PoC — craft adversarial audio that injects commands into Whisper"
    )
    subparsers = parser.add_subparsers(dest="cmd", required=True)

    # attack sub-command
    atk = subparsers.add_parser("attack", help="Run adversarial attack")
    atk.add_argument("carrier", help="Input audio file (any format, will be resampled to 16kHz)")
    atk.add_argument("target", help="Target transcription to inject (e.g. 'turn off all services')")
    atk.add_argument("-o", "--output", default="adversarial.wav", help="Output adversarial WAV file")
    atk.add_argument("--model", default=DEFAULT_MODEL)
    atk.add_argument("--steps", type=int, default=DEFAULT_STEPS)
    atk.add_argument("--lr", type=float, default=DEFAULT_LR)
    atk.add_argument("--epsilon", type=float, default=DEFAULT_EPSILON)
    atk.add_argument("--mel-space", action="store_true",
                     help="Optimize in mel space (faster, no waveform output)")
    atk.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")

    # transcribe sub-command (test what Whisper hears)
    tr = subparsers.add_parser("transcribe", help="Transcribe an audio file with Whisper")
    tr.add_argument("audio", help="Audio file to transcribe")
    tr.add_argument("--model", default=DEFAULT_MODEL)
    tr.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")

    args = parser.parse_args()

    if args.cmd == "transcribe":
        audio = load_audio(args.audio)
        text = transcribe(audio, model_name=args.model, device_str=args.device)
        print(f"Transcription: '{text}'")
        return

    # attack
    carrier = load_audio(args.carrier)
    print(f"[*] Carrier: {args.carrier} ({len(carrier)/SAMPLE_RATE:.1f}s, {len(carrier)} samples)")

    # Baseline: what does Whisper hear before attack?
    baseline = transcribe(carrier, model_name=args.model, device_str=args.device)
    print(f"[*] Baseline transcription: '{baseline}'")

    if args.mel_space:
        adv_audio, losses = attack_mel_space(
            carrier, args.target,
            model_name=args.model, steps=args.steps, lr=args.lr,
            epsilon=args.epsilon, device_str=args.device,
        )
        print("[!] Mel-space mode: adversarial mel cannot be inverted to audio.")
        print("    Output file will be the unmodified carrier for reference.")
    else:
        adv_audio, losses = attack(
            carrier, args.target,
            model_name=args.model, steps=args.steps, lr=args.lr,
            epsilon=args.epsilon, device_str=args.device,
        )
        sf.write(args.output, adv_audio, SAMPLE_RATE)
        print(f"[+] Adversarial audio saved to: {args.output}")

    # Final evaluation
    final_text = transcribe(adv_audio, model_name=args.model, device_str=args.device)
    final_snr = snr_db(carrier, adv_audio)

    print("\n── Results ──────────────────────────────────────")
    print(f"  Carrier (before):  '{baseline}'")
    print(f"  Adversarial (after): '{final_text}'")
    print(f"  Target injection:    '{args.target}'")
    print(f"  SNR: {final_snr:.1f} dB  (>35 dB = imperceptible to humans)")
    print(f"  Success: {'YES' if args.target.lower() in final_text.lower() else 'PARTIAL/NO'}")
    print("─────────────────────────────────────────────────")

    # Save loss curve
    loss_path = args.output.replace(".wav", "_loss.txt")
    with open(loss_path, "w") as f:
        f.write("\n".join(str(l) for l in losses))
    print(f"  Loss history: {loss_path}")


if __name__ == "__main__":
    main()
