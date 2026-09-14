"""Metadata-only handlers — the graceful floor.

Every file gets a metadata block no matter what; here the content block stays
empty and the model works from metadata plus the storage path alone (enough to
script against it later). Images additionally record dimensions/EXIF basics —
their *content* is handled at chat time by native model vision.
"""

import os

from ..result import HandlerResult


def _base_meta(path: str, filename: str) -> dict:
    meta: dict = {}
    try:
        st = os.stat(path)
        meta["sizeBytes"] = st.st_size
    except OSError:
        pass
    return meta


def handle(path: str, filename: str, job: object) -> HandlerResult:
    return HandlerResult(
        status="unsupported",
        processor_group="metadata",
        meta=_base_meta(path, filename),
    )


def handle_image(path: str, filename: str, job: object) -> HandlerResult:
    meta = _base_meta(path, filename)
    try:
        from PIL import ExifTags, Image

        with Image.open(path) as im:
            meta["width"], meta["height"] = im.size
            meta["format"] = im.format
            exif = im.getexif()
            if exif:
                wanted = {"DateTimeOriginal", "Make", "Model", "Orientation"}
                for tag_id, value in exif.items():
                    name = ExifTags.TAGS.get(tag_id, "")
                    if name in wanted:
                        meta.setdefault("exif", {})[name] = str(value)[:120]
    except Exception:  # noqa: BLE001 — corrupt/exotic image: keep base meta
        pass

    # `ready`: with native vision the image is fully usable by the model.
    return HandlerResult(status="ready", processor_group="image", meta=meta)
