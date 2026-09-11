"""
Daisy Docs — local RAG for the daisy chain.

Indexes text files from a folder into a persistent local vector store
(embeddings from Ollama's nomic-embed-text), and answers the question
"which chunks of my own files are relevant to this query?" for the
search_documents tool.

Everything is local: no network, no external services. Storage is a single
JSON index file (cosine similarity over a few thousand chunks is fast enough
and keeps the app dependency-free).
"""

import json
import os
import re
import time

import daisy_chain as dc  # reuses the engine's ollama client + logging

HOME = os.path.expanduser("~")
DOCS_DIR = os.path.join(HOME, "daisy_docs")          # documents to index
INDEX_FILE = os.path.join(HOME, "daisy_docs_index.json")

EMBED_MODEL = "nomic-embed-text:v1.5"
CHUNK_SIZE = 900          # characters per chunk (~200-250 tokens)
CHUNK_OVERLAP = 150       # overlap so sentences split across chunks stay findable
TOP_K = 4                 # chunks returned per search
# Calibrated against nomic-embed-text v1.5: on-topic queries for a chunk score
# ~0.56-0.76, unrelated topics ~0.30-0.46. 0.45 keeps noise out; borderline
# matches still flow through — the worker is instructed to say so when the
# retrieved text doesn't actually answer the question.
MIN_SCORE = 0.45
MAX_FILE_BYTES = 2_000_000  # skip files over 2 MB

TEXT_EXTS = {".txt", ".md", ".py", ".js", ".ts", ".json", ".csv", ".html",
             ".css", ".sh", ".yaml", ".yml", ".xml", ".rst", ".log", ".toml",
             ".swift", ".go", ".rs", ".java", ".c", ".h", ".cpp"}

# ---------------------------------------------------------------------------
# index storage


def _load_index():
    try:
        with open(INDEX_FILE) as f:
            idx = json.load(f)
        if isinstance(idx, dict) and isinstance(idx.get("chunks"), list):
            return idx
    except Exception:
        pass
    return {"chunks": [], "files": {}, "built_at": None}


def _save_index(idx):
    with open(INDEX_FILE, "w") as f:
        json.dump(idx, f)


def index_stats():
    idx = _load_index()
    return {"files": len(idx["files"]), "chunks": len(idx["chunks"]),
            "built_at": idx.get("built_at"), "docs_dir": DOCS_DIR,
            "index_mb": round(os.path.getsize(INDEX_FILE) / 1e6, 2)
            if os.path.exists(INDEX_FILE) else 0}


# ---------------------------------------------------------------------------
# embedding

_embed_cache = {}


def _embed(text):
    """Embed one text via the local Ollama embedding model (cached)."""
    key = hash(text)
    if key in _embed_cache:
        return _embed_cache[key]
    resp = dc.ollama.embed(model=EMBED_MODEL, input=text[:8000])
    vec = resp["embeddings"][0]
    if len(_embed_cache) > 2000:
        _embed_cache.clear()
    _embed_cache[key] = vec
    return vec


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5 or 1.0
    nb = sum(x * x for x in b) ** 0.5 or 1.0
    return dot / (na * nb)


# ---------------------------------------------------------------------------
# chunking + indexing

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")


def _chunk_text(text):
    """Paragraph-first, then sentence-boundary splitting with overlap."""
    paras = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks, cur = [], ""
    for para in paras:
        piece = para if len(para) <= CHUNK_SIZE else ""
        if piece:
            candidate = (cur + "\n\n" + piece).strip() if cur else piece
            if len(candidate) <= CHUNK_SIZE:
                cur = candidate
                continue
            if cur:
                chunks.append(cur)
            cur = piece
            continue
        # long paragraph: split on sentences
        sents = _SENT_SPLIT.split(para)
        for s in sents:
            s = s.strip()
            if not s:
                continue
            if len(s) > CHUNK_SIZE:  # pathological single sentence: hard split
                s = s[:CHUNK_SIZE]
            candidate = (cur + " " + s).strip() if cur else s
            if len(candidate) > CHUNK_SIZE:
                if cur:
                    chunks.append(cur)
                cur = (cur[-CHUNK_OVERLAP:] + " " + s).strip() if cur else s
            else:
                cur = candidate
    if cur:
        chunks.append(cur)
    return chunks


def _readable(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in TEXT_EXTS:
        return False
    try:
        return os.path.getsize(path) <= MAX_FILE_BYTES
    except OSError:
        return False


def _iter_doc_files(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            if _readable(p):
                yield p


def index_docs(progress=None):
    """Re-index everything under DOCS_DIR. Incremental: unchanged files
    (same size + mtime) keep their existing embeddings."""
    if not os.path.isdir(DOCS_DIR):
        os.makedirs(DOCS_DIR, exist_ok=True)
        return {"indexed": 0, "skipped": 0, "chunks": 0, "files": 0,
                "message": f"created empty docs folder {DOCS_DIR} — put files in it and index again"}

    idx = _load_index()
    old_files = idx["files"]
    new_files, chunks, indexed, skipped = {}, [], 0, 0

    paths = sorted(_iter_doc_files(DOCS_DIR))
    for i, path in enumerate(paths):
        rel = os.path.relpath(path, DOCS_DIR)
        st = os.stat(path)
        sig = f"{st.st_size}:{int(st.st_mtime)}"
        if old_files.get(rel, {}).get("sig") == sig and old_files[rel].get("chunks"):
            new_files[rel] = old_files[rel]
            for ch in old_files[rel]["chunks"]:
                chunks.append({"file": rel, "chunk": ch["chunk"],
                               "text": ch["text"], "vec": ch["vec"]})
            skipped += 1
            continue
        try:
            with open(path, errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        pieces = _chunk_text(text)
        file_chunks = []
        for n, piece in enumerate(pieces):
            vec = _embed(piece)
            ch = {"chunk": n, "text": piece, "vec": vec}
            file_chunks.append(ch)
            chunks.append({"file": rel, **ch})
        new_files[rel] = {"sig": sig, "chunks": file_chunks}
        indexed += 1
        if progress:
            progress(i + 1, len(paths), rel)

    idx.update({"chunks": chunks, "files": new_files,
                "built_at": time.strftime("%Y-%m-%d %H:%M:%S")})
    _save_index(idx)
    return {"indexed": indexed, "skipped": skipped, "chunks": len(chunks),
            "files": len(new_files)}


def search_docs(query, top_k=TOP_K):
    """The RAG retrieval step: query -> ranked chunks. Returns a list of
    {file, chunk, score, text}. Empty list means nothing relevant found."""
    if not query or not query.strip():
        return []
    idx = _load_index()
    if not idx["chunks"]:
        return []
    qvec = _embed(query)
    scored = []
    for ch in idx["chunks"]:
        score = _cosine(qvec, ch["vec"])
        if score >= MIN_SCORE:
            scored.append((score, ch))
    scored.sort(key=lambda t: -t[0])
    return [{"file": ch["file"], "chunk": ch["chunk"],
             "score": round(s, 3), "text": ch["text"]}
            for s, ch in scored[:top_k]]


if __name__ == "__main__":
    import sys
    if "--reindex" in sys.argv:
        t0 = time.time()

        def prog(done, total, rel):
            print(f"  [{done}/{total}] {rel}")
        res = index_docs(prog)
        print(f"indexed {res['indexed']} files ({res['skipped']} unchanged), "
              f"{res['chunks']} chunks in {time.time()-t0:.1f}s -> {INDEX_FILE}")
    elif "--stats" in sys.argv:
        print(json.dumps(index_stats(), indent=2))
    else:
        q = " ".join(a for a in sys.argv[1:] if a)
        if not q:
            print("usage: daisy_docs.py 'question' | --reindex | --stats")
            sys.exit(1)
        hits = search_docs(q)
        for h in hits:
            print(f"[{h['score']:.3f}] {h['file']}#{h['chunk']}: {h['text'][:120]}...")
        if not hits:
            print("no relevant chunks")
