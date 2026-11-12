"""Convert Discourse `cooked` HTML to compact markdown, keeping code fences intact.

Also returns the content-image URLs (not emoji/avatars) so a later vision stage can
fetch screenshots only for the records that survive filtering.
"""
from __future__ import annotations

import re

from selectolax.lexbor import LexborHTMLParser

_SPACE = re.compile(r"[ \t\r\n]+")
_HEADING = {"h1": "#", "h2": "##", "h3": "###", "h4": "####", "h5": "#####", "h6": "######"}
_SKIP_CLASSES = ("meta", "lightbox-wrapper-meta", "filename", "informations", "clicks")


def _lang(code) -> str:
    cls = (code.attributes.get("class") or "") if code is not None else ""
    for c in cls.split():
        if c.startswith("lang-"):
            lang = c[5:]
            return "lua" if lang in ("luau", "lua", "auto") else lang
    return ""


def html_to_md(html: str) -> tuple[str, list[str]]:
    if not html:
        return "", []
    tree = LexborHTMLParser(html)
    body = tree.body
    if body is None:
        return "", []
    images: list[str] = []

    def children(node) -> str:
        parts = []
        c = node.child
        while c is not None:
            parts.append(render(c))
            c = c.next
        return "".join(parts)

    def render(node) -> str:
        tag = node.tag
        if tag == "-text":
            return _SPACE.sub(" ", node.text())
        if tag == "-comment":
            return ""
        cls = node.attributes.get("class") or ""
        if tag == "pre":
            code = node.css_first("code")
            src = (code or node).text(deep=True)
            return f"\n\n```{_lang(code)}\n{src.strip(chr(10))}\n```\n\n"
        if tag == "code":
            t = node.text(deep=True)
            return f"`{t}`" if t.strip() else ""
        if tag == "img":
            if "emoji" in cls or "avatar" in cls:
                return node.attributes.get("alt") or ""
            src = node.attributes.get("src") or node.attributes.get("data-orig-src") or ""
            if src:
                images.append(src)
            return "[image]"
        if tag == "br":
            return "\n"
        if tag == "hr":
            return "\n\n---\n\n"
        if tag in _HEADING:
            return f"\n\n{_HEADING[tag]} {children(node).strip()}\n\n"
        if tag == "li":
            return f"\n- {children(node).strip()}"
        if tag in ("ul", "ol"):
            if tag == "ol":
                items = [render(li).strip()[2:].strip() for li in node.css("li")]
                return "\n" + "\n".join(f"{i}. {t}" for i, t in enumerate(items, 1)) + "\n\n"
            return children(node) + "\n\n"
        if tag == "blockquote" or (tag == "aside" and "quote" in cls):
            inner = node.css_first("blockquote") if tag == "aside" else node
            text = children(inner if inner is not None else node).strip()
            return "\n\n" + "\n".join("> " + ln for ln in text.splitlines()) + "\n\n"
        if tag == "aside":  # onebox / other embeds: keep nothing but a marker
            return "\n[embed]\n"
        if tag == "a":
            if "mention" in cls:
                return "@user"
            text = children(node).strip()
            href = node.attributes.get("href") or ""
            if "lightbox" in cls:
                return text
            if text and href.startswith("http") and text != href:
                return f"[{text}]({href})"
            return text or href
        if tag == "strong" or tag == "b":
            t = children(node).strip()
            return f"**{t}**" if t else ""
        if tag == "em" or tag == "i":
            t = children(node).strip()
            return f"*{t}*" if t else ""
        if tag in ("script", "style"):
            return ""
        if any(k in cls for k in _SKIP_CLASSES):
            return ""
        if tag in ("p", "div", "details", "summary", "table", "tr"):
            return "\n\n" + children(node).strip() + "\n\n"
        if tag in ("td", "th"):
            return children(node).strip() + " | "
        return children(node)

    text = children(body)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text, images
