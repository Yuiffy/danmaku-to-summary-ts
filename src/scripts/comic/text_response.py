"""Final text extraction for Python OpenAI-compatible provider adapters."""

from typing import Any

INCOMPLETE_TEXT_STATES = {"length", "max_tokens", "max_output_tokens", "content_filter", "incomplete",
                          "failed", "failure", "cancelled", "canceled", "queued", "in_progress"}


def has_incomplete_text_generation(metadata: Any) -> bool:
    if not isinstance(metadata, dict):
        return False
    attempts = metadata.get("attempts")
    last_success = next((row for row in reversed(attempts) if isinstance(row, dict) and row.get("status") == "success"), {}) if isinstance(attempts, list) else {}
    return any(str(value or "").lower() in INCOMPLETE_TEXT_STATES for value in (
        metadata.get("status"), metadata.get("finishReason"), last_success.get("finishReason")))


def extract_text_parts(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        return [part for item in value for part in extract_text_parts(item)]
    if not isinstance(value, dict):
        return []

    item_type = str(value.get("type") or "").lower()
    if item_type in ("text", "output_text"):
        text = value.get("text")
        if isinstance(text, dict):
            text = text.get("value")
        if isinstance(text, str) and text.strip():
            return [text]
    return extract_text_parts(value.get("content"))


def extract_text_content(result: Any) -> str:
    if not isinstance(result, dict):
        return ""

    output = result.get("output")
    messages = [item for item in output if isinstance(item, dict) and item.get("type") == "message"] if isinstance(output, list) else []
    if any(item.get("phase") in ("commentary", "final_answer") for item in messages):
        assistant = [item for item in messages if item.get("role") in (None, "assistant")]
        final = [item for item in assistant if item.get("phase") == "final_answer"]
        selected = final or [item for item in assistant if item.get("phase") is None]
        # Never promote progress to an answer after a missing or refused final.
        return "\n".join(part.strip() for part in extract_text_parts(selected) if part.strip())

    choices = result.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0] if isinstance(choices[0], dict) else {}
        message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
        parts = extract_text_parts(message.get("content"))
        if not parts:
            parts = extract_text_parts(choice.get("text"))
        if parts:
            return "\n".join(part.strip() for part in parts if part.strip()).strip()

    parts = extract_text_parts(result.get("output_text"))
    if not parts:
        parts = extract_text_parts(result.get("output"))
    return "\n".join(part.strip() for part in parts if part.strip()).strip()
