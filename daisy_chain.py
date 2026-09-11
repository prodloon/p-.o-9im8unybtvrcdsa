import json
import ollama
import os
import re
import time
import threading
import subprocess
import importlib.metadata
import urllib.request
import shutil
from datetime import datetime, timezone

# --- Terminal colors (plain ANSI codes, no dependencies) ---
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
YELLOW = "\033[33m"
RED = "\033[31m"
GREEN = "\033[32m"
BLUE = "\033[34m"
MAGENTA = "\033[35m"
ORANGE = "\033[38;5;208m"  # provisioner/broker accents

ROUTE_COLORS = {
    'coding': GREEN,
    'general': BLUE,
    'fast_chat': MAGENTA,
}

# 1. Define your local agent pool
ROUTER_MODEL = 'qwen2.5:1.5b'  # Fastest model for intent classification
AGENT_POOL = {
    'coding': 'qwen2.5-coder:7b',  # Purpose-built code model
    'general': 'llama3.1',       # Meta's deep reasoning 8B model
    'fast_chat': 'llama3.2:3b'   # High-speed 3B model for simple tasks
}

# 2. Skill library the Broker can attach to any task
BROKER_MODEL = 'qwen2.5:1.5b'   # Used only when BROKER_USES_MODEL is True
BROKER_USES_MODEL = False       # Flip to True on faster hardware; see select_skills
MAX_SKILLS_PER_TASK = 2

SKILLS = {
    'code_review': (
        "Before answering, mentally review your code for bugs, typos and wrong variable names. "
        "Provide complete, runnable code with correct syntax, and mention edge cases briefly."
    ),
    'math_reasoning': (
        "Work through any calculation step by step, show the reasoning, then state the final "
        "answer on its own line prefixed with 'Answer:'."
    ),
    'debugging': (
        "First identify the most likely root cause in one sentence, then give the minimal fix, "
        "then explain how to verify it."
    ),
    'summarize': (
        "Be concise: lead with the key point, then at most 3-5 short bullet points."
    ),
    'creative_writing': (
        "Use vivid, varied language and a strong opening line. Avoid clichés."
    ),
    'explain_simply': (
        "Explain as if to a smart beginner: one analogy, no unexplained jargon, short paragraphs."
    ),
}

def filter_and_route(user_prompt):
    print(f"{CYAN}🤖 [Gatekeeper] Analyzing request with {ROUTER_MODEL}...{RESET}")
    
    # System prompt forces the 1.5B model to only return a clean JSON classification
    system_instruction = (
        "You are a routing agent. Analyze the user's prompt and classify it into exactly "
        "one of these categories: 'coding', 'general', or 'fast_chat'. "
        "Respond ONLY with a valid JSON object containing a single key 'route'. "
        "Example: {\"route\": \"coding\"}"
    )

    response = ollama.chat(
        model=ROUTER_MODEL,
        messages=[
            {'role': 'system', 'content': system_instruction},
            {'role': 'user', 'content': f"Classify this prompt: {user_prompt}"}
        ],
        options={'temperature': 0.0} # Set to 0 for strict rule adherence
    )
    
    # Clean and parse the JSON response
    try:
        result = json.loads(response['message']['content'].strip())
        target_route = result.get('route', 'general')
    except Exception:
        # Fallback to general if the model outputs messy text
        text = response['message']['content'].lower()
        if 'coding' in text: target_route = 'coding'
        elif 'fast_chat' in text: target_route = 'fast_chat'
        else: target_route = 'general'

    return target_route

def select_skills(user_prompt):
    """Skill Broker: choose 0-N relevant skills for this task; returns skill names.

    Primary mode is a deterministic keyword scorer: instant, reliable, and easy to
    extend (edit SKILL_KEYWORDS). Set BROKER_USES_MODEL = True to have the broker
    model pick skills instead — more flexible, but slower and noisier on small models.
    """
    if not BROKER_USES_MODEL:
        text = user_prompt.lower()
        scores = {}
        for name, keywords in SKILL_KEYWORDS.items():
            hits = sum(1 for kw in keywords if kw in text)
            if hits:
                scores[name] = hits
        ranked = sorted(scores.items(), key=lambda item: -item[1])
        return [name for name, _ in ranked[:MAX_SKILLS_PER_TASK]]

    skill_menu = "; ".join(f"{name} = {SKILLS[name].split('.')[0].lower()}" for name in SKILLS)
    system_instruction = (
        "You are a skill broker. Given a task, choose which specialist skills would most "
        f"improve the answer. Available skills: {skill_menu}. "
        f"Choose only skills that clearly apply to the task: most tasks need 0 or 1 skills, "
        f"never more than {MAX_SKILLS_PER_TASK}. For example, a calculation needs "
        "math_reasoning, not code skills. Respond ONLY with valid JSON like "
        "{\"skills\": [\"math_reasoning\"]} or {\"skills\": []} if none apply. No other text."
    )
    try:
        response = ollama.chat(
            model=BROKER_MODEL,
            messages=[
                {'role': 'system', 'content': system_instruction},
                {'role': 'user', 'content': f"Task: {user_prompt}"}
            ],
            options={'temperature': 0.0}
        )
        result = json.loads(response['message']['content'].strip())
        chosen = result.get('skills', [])
        if not isinstance(chosen, list):
            raise ValueError("skills must be a list")
        return [s for s in chosen if s in SKILLS][:MAX_SKILLS_PER_TASK]
    except Exception:
        # Keyword fallback if the broker model stumbles on its JSON
        return _keyword_skills(user_prompt)

def _keyword_skills(user_prompt):
    text = user_prompt.lower()
    scores = {}
    for name, keywords in SKILL_KEYWORDS.items():
        hits = sum(1 for kw in keywords if kw in text)
        if hits:
            scores[name] = hits
    ranked = sorted(scores.items(), key=lambda item: -item[1])
    return [name for name, _ in ranked[:MAX_SKILLS_PER_TASK]]

# Skill triggers for the keyword broker (word fragments matched with 'in')
SKILL_KEYWORDS = {
    'code_review': ('code', 'function', 'script', 'python', 'program', 'class', 'algorithm', 'refactor'),
    'debugging': ('bug', 'error', 'crash', 'traceback', 'exception', 'fix', 'broken', 'not working', 'fails'),
    'math_reasoning': ('calculate', 'math', 'percent', '%', 'sum of', 'multiply', 'divide', 'how many', 'average', 'probability'),
    'summarize': ('summarize', 'summary', 'tldr', 'bullet points', 'key points', 'shorten'),
    'creative_writing': ('story', 'poem', 'song', 'fiction', 'character', 'plot', 'screenplay'),
    'explain_simply': ('explain', 'how does', 'why does', 'teach me', 'eli5'),
}

# ============================================================================
# 3. The Provisioner — autonomous background agent
#
# Uses the internet freely (PyPI metadata API, GitHub REST API, the Ollama
# registry) to research, install and audit things that improve this program.
# Guardrails: only known-safe sources, dry-run by default, everything logged.
# ============================================================================

PROVISIONER_LOG_FILE = "provisioner_log.json"
PROVISIONER_REPORTS_FILE = "provisioner_reports.json"
PROVISIONER_QUEUE_FILE = "provisioner_queue.json"
PROVISIONER_PENDING_FILE = "provisioner_pending.json"   # dry-run suggestions awaiting approval
PROVISIONER_PREFS_FILE = "provisioner_prefs.json"       # user preferences (update channel, etc.)
PROVISIONER_CYCLE_SECONDS = 300          # heartbeat interval
AUTO_INSTALL = False                     # dry-run by default; flip to True to allow installs
PENDING_MAX = 20                         # cap on unapproved suggestions

SANDBOX_ROOT = os.path.expanduser("~/daisy_sandbox")  # clones land here, audits are text-only
SANDBOX_MAX_DISK_MB = 1024               # refuse to let the sandbox balloon
REPO_REAUDIT_HOURS = 24                  # don't re-audit a repo more often than this
REPOS_PER_CYCLE = 2                      # pace heavy repo audits across cycles

# Curated queue: useful, popular repos to audit for inspiration/learning
CURATED_REPOS = [
    "pallets/flask",
    "psf/requests",
    "langchain-ai/langchain",
    "huggingface/transformers",
]

# Static scan patterns: (regex, severity, description). TEXT-ONLY analysis.
RISKY_PATTERNS = [
    (r"\b(?:aws_secret_access_key|aws_access_key_id)\s*=\s*['\"][A-Za-z0-9/+]{16,}", "critical", "hardcoded AWS key"),
    (r"sk-[A-Za-z0-9]{20,}", "critical", "hardcoded API key (sk-...)"),
    (r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "critical", "embedded private key"),
    (r"\bghp_[A-Za-z0-9]{30,}\b", "critical", "hardcoded GitHub token"),
    (r"\beval\s*\(|\bexec\s*\(", "high", "eval/exec usage"),
    (r"subprocess\.[a-z_]+\(.*shell\s*=\s*True", "high", "subprocess with shell=True"),
    (r"os\.system\s*\(", "high", "os.system call"),
    (r"(curl|wget)[^\n]{0,40}\|\s*(?:ba)?sh", "high", "curl|bash pipe-to-shell"),
    (r"pickle\.loads?\s*\(", "medium", "pickle deserialization"),
    (r"yaml\.load\s*\((?![^)]*Loader\s*=)", "medium", "unsafe yaml.load without Loader"),
    (r"requests\.get\s*\(\s*['\"]http://", "medium", "plain-http request"),
    (r"verify\s*=\s*False", "high", "SSL verification disabled"),
]


_GH_JSON_CACHE = {}      # url -> (fetched_at, parsed_json)
_GH_CACHE_TTL = 600      # 10 min: GitHub allows only 60 req/hr unauthenticated

def _http_get_json(url, timeout=10):
    """GET a URL and parse JSON, with a TTL cache for api.github.com.

    The cache exists because GitHub cuts unauthenticated clients off at 60
    requests/hour per IP; the provisioner + release watcher were burning that
    in under 20 minutes. Non-GitHub URLs (PyPI) pass through uncached."""
    if url.startswith('https://api.github.com/'):
        now = time.time()
        hit = _GH_JSON_CACHE.get(url)
        if hit and now - hit[0] < _GH_CACHE_TTL:
            return hit[1]
    req = urllib.request.Request(url, headers={
        'User-Agent': 'daisy-chain-provisioner/1.0',
        'Accept': 'application/vnd.github+json',
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode('utf-8', errors='replace'))
    if url.startswith('https://api.github.com/'):
        _GH_JSON_CACHE[url] = (time.time(), data)
    return data


def _provisioner_log(action, detail):
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": action,
        "detail": detail,
    }
    data = []
    if os.path.exists(PROVISIONER_LOG_FILE):
        try:
            with open(PROVISIONER_LOG_FILE, 'r') as f:
                data = json.load(f)
        except Exception:
            data = []
    if not isinstance(data, list):
        data = []
    data.append(entry)
    try:
        with open(PROVISIONER_LOG_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


_provisioner_silent = False  # suppresses thread console output during interactive prompts

def _log_print(icon, msg):
    if _provisioner_silent:
        return  # still logged to file by callers; keeps the prompt readable
    print(f"{DIM}{icon} {datetime.now().strftime('%H:%M:%S')} [Provisioner] {msg}{RESET}")


# --- Research: ask the internet what's worth having -------------------------

def fetch_popular_ollama_models(limit=5):
    """Suggest known-good local models the user hasn't pulled yet."""
    known_good = ['qwen2.5-coder:7b', 'llama3.2:1b', 'smollm2:1.7b', 'gemma2:2b']
    try:
        resp = ollama.list()
        # ollama lib >= 0.4 returns a pydantic ListResponse; older versions a dict
        installed_raw = getattr(resp, 'models', None)
        if installed_raw is None and isinstance(resp, dict):
            installed_raw = resp.get('models')
        installed = set()
        for m in installed_raw or []:
            if isinstance(m, dict):
                name = m.get('model') or m.get('name')
            else:
                name = getattr(m, 'model', None) or getattr(m, 'name', None) or str(m)
            if name:
                installed.add(name)
        return [m for m in known_good if not any(m == n or n.startswith(m) for n in installed)][:limit]
    except Exception:
        return []


def fetch_pypi_suggestions():
    """Check PyPI for newer versions of packages this program depends on."""
    interesting = ['ollama']
    out = []
    for pkg in interesting:
        try:
            data = _http_get_json(f"https://pypi.org/pypi/{pkg}/json")
            latest = data['info']['version']
            try:
                installed = importlib.metadata.version(pkg)
            except Exception:
                installed = None
            if installed and installed == latest:
                continue  # already up to date, nothing to propose
            out.append({'package': pkg, 'latest': latest, 'installed': installed})
        except Exception as e:
            _provisioner_log('pypi_check_failed', {'package': pkg, 'error': str(e)})
    return out


def fetch_github_repo_health(repo):
    """GitHub REST API: stars, last push, open issues — used by the safety checklist."""
    try:
        data = _http_get_json(f"https://api.github.com/repos/{repo}")
        return {
            'repo': repo,
            'stars': data.get('stargazers_count', 0),
            'last_push': data.get('pushed_at', ''),
            'open_issues': data.get('open_issues_count', 0),
            'archived': data.get('archived', False),
        }
    except Exception as e:
        _provisioner_log('github_check_failed', {'repo': repo, 'error': str(e)})
        return None


def _parse_semver(text):
    """'v0.12.6', '0.12.6-rc1', 'ollama version is 0.12.6' -> (0, 12, 6)."""
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else None


def get_installed_ollama_version():
    """Installed server version via the local API; CLI as fallback."""
    try:
        with urllib.request.urlopen("http://localhost:11434/api/version", timeout=5) as r:
            return json.loads(r.read().decode('utf-8', errors='replace')).get('version', '')
    except Exception:
        pass
    try:
        result = subprocess.run(['ollama', '--version'], capture_output=True, text=True, timeout=10)
        return (result.stdout or result.stderr or '').strip()
    except Exception:
        return None


_last_release_info = None  # surfaced by the manual 'provisioner' status line

def check_ollama_releases():
    """Compare installed Ollama against the latest stable AND newest pre-release."""
    global _last_release_info
    installed_raw = get_installed_ollama_version()
    installed = _parse_semver(installed_raw)
    try:
        data = _http_get_json("https://api.github.com/repos/ollama/ollama/releases/latest")
        latest = _parse_semver(data.get('tag_name', ''))
    except Exception as e:
        _provisioner_log('release_check_failed', str(e))
        return None
    if not latest:
        return None
    # Newest pre-release (experimental channel, shown but never pushed hard)
    newest_pre = None
    try:
        rels = _http_get_json("https://api.github.com/repos/ollama/ollama/releases?per_page=10")
        for rel in rels:
            if rel.get('prerelease'):
                tag = (rel.get('tag_name') or '').lstrip('v')
                if _parse_semver(tag):
                    newest_pre = {'tag': tag, 'ver': _parse_semver(tag),
                                  'date': (rel.get('published_at') or '')[:10]}
                    break
    except Exception as e:
        _provisioner_log('prerelease_check_failed', str(e))
    info = {
        'installed_raw': installed_raw,
        'installed': '.'.join(map(str, installed)) if installed else None,
        'latest': '.'.join(map(str, latest)),
        'update_available': bool(installed and latest > installed),
    }
    if newest_pre:
        info['prerelease'] = newest_pre['tag']
        info['prerelease_newer'] = bool(
            installed and newest_pre['ver'] > installed and newest_pre['ver'] > latest
            and _channel_allows_prereleases())
        info['prerelease_date'] = newest_pre['date']
    _provisioner_log('release_check', info)
    _last_release_info = info
    return info


def alert_release(info):
    """Print the update banner once per new release tag (deduped via the log)."""
    if not info or not info.get('update_available'):
        return
    tag = info['latest']
    try:
        if os.path.exists(PROVISIONER_LOG_FILE):
            with open(PROVISIONER_LOG_FILE, 'r') as f:
                log = json.load(f)
            if any(e.get('action') == 'release_alert' and
                   isinstance(e.get('detail'), dict) and e['detail'].get('tag') == tag
                   for e in log):
                return  # already alerted for this tag
    except Exception:
        pass
    if not _provisioner_silent:
        print(f"\n{ORANGE}{BOLD}📢 Ollama update available!{RESET} "
              f"installed: {info.get('installed') or '?'} → latest: {tag}")
        print(f"{DIM}   Download: https://ollama.com/download")
        print(f"   The provisioner flags updates but never auto-replaces the app — install it yourself.{RESET}\n")
    _provisioner_log('release_alert', {'tag': tag, 'installed': info.get('installed')})
    # Distinct, softer notice for pre-releases — informational, never nagged twice
    if info.get('prerelease_newer'):
        pre_key = f"pre:{info['prerelease']}"
        already = False
        try:
            if os.path.exists(PROVISIONER_LOG_FILE):
                with open(PROVISIONER_LOG_FILE, 'r') as f:
                    log = json.load(f)
                already = any(e.get('action') == 'prerelease_alert' and
                              isinstance(e.get('detail'), dict) and e['detail'].get('key') == pre_key
                              for e in log)
        except Exception:
            pass
        if not already and not _provisioner_silent:
            print(f"{ORANGE}{BOLD}🧪 Pre-release available (experimental):{RESET} "
                  f"{info['prerelease']} ({info.get('prerelease_date', '?')})")
            print(f"{DIM}   Ahead of stable {info['latest']} — new features, less tested. "
                  f"Only jump on it deliberately: https://github.com/ollama/ollama/releases{RESET}\n")
        _provisioner_log('prerelease_alert', {'key': pre_key, 'tag': info['prerelease']})


def check_pypi_package_releases(pkg='ollama'):
    """Compare the venv's installed version of a PyPI package against PyPI's latest."""
    try:
        installed = importlib.metadata.version(pkg)
    except Exception:
        installed = None  # not installed in this venv
    try:
        data = _http_get_json(f"https://pypi.org/pypi/{pkg}/json")
        latest = data.get('info', {}).get('version', '')
    except Exception as e:
        _provisioner_log('pypi_release_check_failed', {'package': pkg, 'error': str(e)})
        return None
    if not latest:
        return None
    inst_sv, latest_sv = _parse_semver(installed), _parse_semver(latest)
    info = {
        'package': pkg,
        'installed': installed,
        'latest': latest,
        'update_available': bool(inst_sv and latest_sv and latest_sv > inst_sv),
        'not_installed': installed is None,
    }
    _provisioner_log('pypi_release_check', info)
    return info


def alert_pypi(info):
    """Print the PyPI update banner once per package+version (deduped via the log)."""
    if not info or not info.get('update_available'):
        return
    key = f"{info['package']}=={info['latest']}"
    try:
        if os.path.exists(PROVISIONER_LOG_FILE):
            with open(PROVISIONER_LOG_FILE, 'r') as f:
                log = json.load(f)
            if any(e.get('action') == 'pypi_alert' and
                   isinstance(e.get('detail'), dict) and e['detail'].get('key') == key
                   for e in log):
                return  # already alerted
    except Exception:
        pass
    if not _provisioner_silent:
        print(f"\n{ORANGE}{BOLD}📢 Python package update available!{RESET} "
              f"{info['package']}: installed {info['installed']} → PyPI {info['latest']}")
        print(f"{DIM}   Update inside the venv with:  ~/daisy_env/bin/pip install -U {info['package']}")
        print(f"   (Or approve it via 'approve' when the provisioner parks the suggestion.{RESET}\n")
    _provisioner_log('pypi_alert', {'key': key, 'installed': info['installed']})


def show_release_history(limit=10):
    """Last N Ollama releases from GitHub, with alert status for each."""
    try:
        data = _http_get_json(f"https://api.github.com/repos/ollama/ollama/releases?per_page={limit}")
    except Exception as e:
        print(f"{RED}⚠️  Could not fetch releases: {e}{RESET}")
        return
    installed = _parse_semver(get_installed_ollama_version())
    alerted_tags = set()
    try:
        if os.path.exists(PROVISIONER_LOG_FILE):
            with open(PROVISIONER_LOG_FILE, 'r') as f:
                log = json.load(f)
            alerted_tags = {e['detail'].get('tag') for e in log
                            if e.get('action') == 'release_alert' and isinstance(e.get('detail'), dict)}
    except Exception:
        pass
    print(f"\n{BOLD}🏷  Last {len(data)} Ollama releases{RESET} "
          f"{DIM}(installed: {'.'.join(map(str, installed)) if installed else '?'}){RESET}")
    for rel in data:
        tag = (rel.get('tag_name') or '').lstrip('v')
        date = (rel.get('published_at') or '')[:10]
        ver = _parse_semver(tag)
        if installed and ver:
            mark = (f"{GREEN}← installed{RESET}" if ver == installed else
                    f"{DIM}(newer than installed){RESET}" if ver > installed else
                    f"{DIM}(older){RESET}")
        else:
            mark = ""
        bell = f"{ORANGE}🔔 alerted{RESET}" if tag in alerted_tags else f"{DIM}·{RESET}"
        pre = " [pre-release]" if rel.get('prerelease') else ""
        print(f"   {BOLD}{tag}{RESET}{pre}  {date}  {bell} {mark}")
    print(f"{DIM}   Full notes: https://github.com/ollama/ollama/releases{RESET}\n")


def _load_prefs():
    """User preferences, persisted; defaults if the file is missing/corrupt."""
    prefs = {'channel': 'stable',
             'cycle_seconds': PROVISIONER_CYCLE_SECONDS,
             'sandbox_max_disk_mb': SANDBOX_MAX_DISK_MB,
             'repo_reaudit_hours': REPO_REAUDIT_HOURS,
             'repos_per_cycle': REPOS_PER_CYCLE,
             'pending_max': PENDING_MAX}
    if os.path.exists(PROVISIONER_PREFS_FILE):
        try:
            with open(PROVISIONER_PREFS_FILE, 'r') as f:
                stored = json.load(f)
            if isinstance(stored, dict):
                prefs.update({k: v for k, v in stored.items()
                              if k in prefs and (not isinstance(prefs[k], int) or isinstance(v, int))})
        except Exception:
            pass
    return prefs


def _pref(key):
    """Current numeric value of a persisted pref (channel handled separately)."""
    return _load_prefs().get(key)


def _save_prefs(prefs):
    try:
        with open(PROVISIONER_PREFS_FILE, 'w') as f:
            json.dump(prefs, f, indent=2)
    except Exception:
        pass


def handle_channels():
    """Interactive update-channel preference: stable-only vs include pre-releases."""
    global _last_release_info
    prefs = _load_prefs()
    print(f"\n{BOLD}📡 Update channel{RESET} — currently: "
          f"{ORANGE}{BOLD}{'stable only' if prefs['channel'] == 'stable' else 'stable + pre-releases'}{RESET}")
    print(f"{DIM}   1 = stable only (recommended; 🧪 notices off)")
    print(f"   2 = include pre-releases (🧪 notices on, so you can ride rc builds)")
    print(f"   anything else = keep current{RESET}")
    try:
        ans = input(f"{CYAN}   choose [1/2]:{RESET} ").strip()
    except (EOFError, KeyboardInterrupt):
        print(f"{DIM}\n   unchanged{RESET}")
        return
    if ans == '1' and prefs['channel'] != 'stable':
        prefs['channel'] = 'stable'
        _save_prefs(prefs)
        _provisioner_log('channel_changed', 'stable')
        print(f"{GREEN}✅ Now watching stable releases only.{RESET}")
    elif ans == '2' and prefs['channel'] != 'all':
        prefs['channel'] = 'all'
        _save_prefs(prefs)
        _provisioner_log('channel_changed', 'all')
        print(f"{GREEN}✅ Now watching pre-releases too — 🧪 notices will appear when a new rc drops.{RESET}")
    else:
        print(f"{DIM}   unchanged{RESET}")
        return
    _last_release_info = None  # force a fresh watcher pass next cycle


def _channel_allows_prereleases():
    return _load_prefs().get('channel') == 'all'


def _dir_size_mb(path):
    """Recursive size of a directory in MB (0 if missing)."""
    if not os.path.isdir(path):
        return 0.0
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total / (1024 * 1024)


def handle_du():
    """Disk usage breakdown: sandbox, Ollama models, venv, and app data files."""
    ollama_models_dir = os.path.expanduser('~/.ollama/models')
    venv_dir = os.path.expanduser('~/daisy_env')

    # Ollama models: total + biggest individual models (from the registry blobs)
    model_rows = []
    blobs = os.path.join(ollama_models_dir, 'blobs')
    blob_sizes = {}
    if os.path.isdir(blobs):
        for name in os.listdir(blobs):
            try:
                blob_sizes[name] = os.path.getsize(os.path.join(blobs, name))
            except OSError:
                pass
    try:
        resp = ollama.list()
        raw = getattr(resp, 'models', None)
        if raw is None and isinstance(resp, dict):
            raw = resp.get('models')
        for m in raw or []:
            name = getattr(m, 'model', None) or getattr(m, 'name', None) if not isinstance(m, dict) \
                else (m.get('model') or m.get('name'))
            size = getattr(m, 'size', None) if not isinstance(m, dict) else m.get('size')
            if name and size:
                model_rows.append((name, size / (1024 * 1024)))
    except Exception:
        pass
    model_rows.sort(key=lambda r: -r[1])

    def bar(mb, max_mb, width=22):
        filled = int(width * mb / max_mb) if max_mb else 0
        return f"{'█' * min(filled, width)}{'░' * (width - min(filled, width))}"

    sandbox_mb = _sandbox_disk_mb()
    models_mb = _dir_size_mb(ollama_models_dir)
    venv_mb = _dir_size_mb(venv_dir)
    data_mb = sum(_file_mb_safe(f) for f in (PROVISIONER_LOG_FILE, PROVISIONER_REPORTS_FILE,
                                             PROVISIONER_QUEUE_FILE, PROVISIONER_PENDING_FILE,
                                             PROVISIONER_PREFS_FILE, 'agent_workload_exports.json'))
    sections = [('Ollama models', models_mb), ('daisy venv', venv_mb),
                ('Repo sandbox', sandbox_mb), ('App data (json logs)', data_mb)]
    max_mb = max((s[1] for s in sections), default=0) or 1

    print(f"\n{BOLD}💾 Disk Usage{RESET}")
    for label, mb in sections:
        print(f"   {label:<22} {bar(mb, max_mb)} {BOLD}{mb:8.1f} MB{RESET}")
    print(f"   {'TOTAL':<22} {bar(sum(s[1] for s in sections), max_mb)} "
          f"{BOLD}{sum(s[1] for s in sections):8.1f} MB{RESET}")

    if model_rows:
        print(f"\n   {BOLD}Largest models{RESET} {DIM}(top 5 of {len(model_rows)}){RESET}")
        for name, mb in model_rows[:5]:
            print(f"   {name:<38} {mb:8.1f} MB")
    if sandbox_mb == 0:
        print(f"{DIM}   (sandbox is empty — clones return after the next repo audit cycle){RESET}")
    try:
        free = subprocess.run(['df', '-h', os.path.expanduser('~')],
                              capture_output=True, text=True, timeout=10)
        print(f"{DIM}   Disk free: {free.stdout.strip().splitlines()[-1].split()[3]}{RESET}\n")
    except Exception:
        print()


def _file_mb_safe(path):
    return os.path.getsize(path) / (1024 * 1024) if os.path.exists(path) else 0.0


def handle_cleanup():
    """Size preview + confirmation, then empty the sandbox, clear parked
    suggestions and trim the provisioner logs."""
    def _file_mb(path):
        return os.path.getsize(path) / (1024 * 1024) if os.path.exists(path) else 0.0

    def _json_mb(path):
        """Size the file would shrink to after trimming (last 100 entries kept)."""
        if not os.path.exists(path):
            return 0.0, 0
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            n = len(data) if isinstance(data, list) else 0
        except Exception:
            return _file_mb(path), 0
        keep = 100
        if n <= keep:
            return _file_mb(path), 0
        import io
        buf = io.BytesIO()
        json.dump(data[-keep:], buf, indent=2)
        return buf.tell() / (1024 * 1024), n - keep

    sandbox_mb = _sandbox_disk_mb()
    parked = len(_load_pending())
    trims = []
    for path in (PROVISIONER_LOG_FILE, PROVISIONER_REPORTS_FILE):
        after, dropped = _json_mb(path)
        if dropped:
            trims.append((path, _file_mb(path), after, dropped))

    print(f"\n{BOLD}🧹 Cleanup preview{RESET}")
    print(f"   1. Repo sandbox ({SANDBOX_ROOT}) : {ORANGE}{sandbox_mb:.0f} MB{RESET} would be deleted")
    print(f"   2. Parked suggestions       : {ORANGE}{parked}{RESET} would be cleared")
    if trims:
        for path, before, after, dropped in trims:
            print(f"   3. {os.path.basename(path):<28}: {ORANGE}{before:.2f} MB → {after:.2f} MB{RESET} {DIM}(drop oldest {dropped}){RESET}")
    else:
        print(f"{DIM}   3. Logs: all under 100 entries — nothing to trim{RESET}")
    try:
        ans = input(f"{CYAN}   proceed? [y/N]:{RESET} ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print(f"{DIM}\n   cancelled{RESET}")
        return
    if ans != 'y':
        print(f"{DIM}   cancelled{RESET}")
        return

    freed = 0.0
    if os.path.isdir(SANDBOX_ROOT):
        shutil.rmtree(SANDBOX_ROOT, ignore_errors=True)
        freed += sandbox_mb
        _provisioner_log('cleanup', f"sandbox emptied ({sandbox_mb:.0f} MB)")
        print(f"{GREEN}✅ Sandbox emptied ({sandbox_mb:.0f} MB freed){RESET} — repos re-clone on next audit cycle")
    if parked:
        _save_pending([])
        _provisioner_log('cleanup', f"cleared {parked} parked suggestion(s)")
        print(f"{GREEN}✅ Cleared {parked} parked suggestion(s){RESET}")
    for path, _before, _after, dropped in trims:
        try:
            with open(path, 'r') as f:
                data = json.load(f)
            with open(path, 'w') as f:
                json.dump(data[-100:], f, indent=2)
            _provisioner_log('cleanup', f"trimmed {path} (dropped {dropped} oldest)")
            print(f"{GREEN}✅ Trimmed {os.path.basename(path)} (dropped {dropped} oldest entries){RESET}")
        except Exception as e:
            print(f"{RED}⚠️  Could not trim {os.path.basename(path)}: {e}{RESET}")
    if sandbox_mb == 0 and not parked and not trims:
        print(f"{DIM}   Nothing to clean.{RESET}")
    print()

def handle_prefs(reset=False):
    """One view of every provisioner setting, with inline toggles.
    reset=True goes straight to the restore-defaults confirmation."""
    prefs = _load_prefs()
    cycle_seconds = prefs['cycle_seconds']
    sandbox_cap = prefs['sandbox_max_disk_mb']
    reaudit_h = prefs['repo_reaudit_hours']
    per_cycle = prefs['repos_per_cycle']
    pmax = prefs['pending_max']
    channel_label = 'stable only' if prefs['channel'] == 'stable' else 'stable + pre-releases'
    disk_mb = _sandbox_disk_mb() if os.path.isdir(SANDBOX_ROOT) else 0
    parked = len(_load_pending())
    queued = len(_sandbox_jobs())

    print(f"\n{BOLD}⚙️  Provisioner Settings{RESET} {DIM}(persisted in {PROVISIONER_PREFS_FILE}){RESET}")
    print(f"{DIM}   (toggle anything by number, 'r' = reset to defaults, Enter to leave unchanged){RESET}")
    print(f"   1. Update channel      : {ORANGE}{channel_label}{RESET} {DIM}(toggle → 'channels' menu){RESET}")
    print(f"   2. Auto-install        : {ORANGE}{'ON' if AUTO_INSTALL else 'OFF (dry-run)'}{RESET} {DIM}(module constant AUTO_INSTALL — edit the file to change){RESET}")
    print(f"   3. Research interval   : {ORANGE}{cycle_seconds}s{RESET}")
    print(f"   4. Sandbox disk cap    : {ORANGE}{sandbox_cap} MB{RESET} {DIM}(currently using {disk_mb:.0f} MB){RESET}")
    print(f"   5. Re-audit cadence    : {ORANGE}every {reaudit_h}h{RESET} {DIM}(repo queue: {queued} repo(s)){RESET}")
    print(f"   6. Repo audits / cycle : {ORANGE}{per_cycle}{RESET}")
    print(f"   7. Pending cap         : {ORANGE}{pmax}{RESET} {DIM}(currently parked: {parked}){RESET}")
    print(f"{DIM}   Files: prefs, queue, pending, reports, log → provisioner_*.json in the working dir{RESET}")

    if reset:
        ans = 'r'  # '--reset-prefs' skips straight to the confirmation
    else:
        try:
            ans = input(f"{CYAN}   toggle #/{'r'}: {RESET}").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print(f"{DIM}\n   unchanged{RESET}")
            return

    if ans == 'r':
        defaults = {'channel': 'stable', 'cycle_seconds': 300, 'sandbox_max_disk_mb': 1024,
                    'repo_reaudit_hours': 24, 'repos_per_cycle': 2, 'pending_max': 20}
        diffs = [f"{k}: {v} → {defaults[k]}" for k, v in prefs.items()
                 if k in defaults and v != defaults[k]]
        if not diffs:
            print(f"{DIM}   all settings already at defaults{RESET}")
            return
        print(f"{ORANGE}   Will restore defaults:{RESET}")
        for d in diffs:
            print(f"     • {d}")
        try:
            confirm = input(f"{CYAN}   confirm reset? [y/N]: {RESET}").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print(f"{DIM}\n   unchanged{RESET}")
            return
        if confirm == 'y':
            _save_prefs(defaults)
            _provisioner_log('prefs_reset', diffs)
            global _last_release_info
            _last_release_info = None
            print(f"{GREEN}✅ All settings restored to defaults — persisted.{RESET}")
        else:
            print(f"{DIM}   unchanged{RESET}")
        return

    if ans == '1':
        handle_channels()
    elif ans == '2':
        print(f"{DIM}   AUTO_INSTALL is a module constant for safety — open daisy_chain.py and set "
              f"AUTO_INSTALL = True. The 'approve' flow is the recommended way to execute parked suggestions.{RESET}")
    elif ans == '3':
        try:
            secs = int(input(f"{CYAN}   new interval in seconds (current {cycle_seconds}): {RESET}").strip())
            if secs >= 30:
                prefs['cycle_seconds'] = secs
                _save_prefs(prefs)
                print(f"{GREEN}✅ Interval now {secs}s — persisted, survives restarts.{RESET}")
            else:
                print(f"{RED}   keep it at 30s or above{RESET}")
        except ValueError:
            print(f"{RED}   not a number — unchanged{RESET}")
    elif ans == '4':
        try:
            mb = int(input(f"{CYAN}   new sandbox cap in MB (current {sandbox_cap}): {RESET}").strip())
            if mb >= 100:
                prefs['sandbox_max_disk_mb'] = mb
                _save_prefs(prefs)
                print(f"{GREEN}✅ Sandbox cap now {mb} MB — persisted.{RESET}")
            else:
                print(f"{RED}   keep it at 100 MB or above{RESET}")
        except ValueError:
            print(f"{RED}   not a number — unchanged{RESET}")
    elif ans == '5':
        try:
            hrs = int(input(f"{CYAN}   re-audit every N hours (current {reaudit_h}): {RESET}").strip())
            if 1 <= hrs <= 168:
                prefs['repo_reaudit_hours'] = hrs
                _save_prefs(prefs)
                print(f"{GREEN}✅ Re-audit cadence now every {hrs}h — persisted.{RESET}")
            else:
                print(f"{RED}   pick 1–168 hours{RESET}")
        except ValueError:
            print(f"{RED}   not a number — unchanged{RESET}")
    elif ans == '6':
        try:
            n = int(input(f"{CYAN}   repo audits per cycle (current {per_cycle}): {RESET}").strip())
            if 1 <= n <= 10:
                prefs['repos_per_cycle'] = n
                _save_prefs(prefs)
                print(f"{GREEN}✅ Now {n} repo audit(s) per cycle — persisted.{RESET}")
            else:
                print(f"{RED}   pick 1–10{RESET}")
        except ValueError:
            print(f"{RED}   not a number — unchanged{RESET}")
    elif ans == '7':
        try:
            n = int(input(f"{CYAN}   pending cap (current {pmax}): {RESET}").strip())
            if 1 <= n <= 100:
                prefs['pending_max'] = n
                _save_prefs(prefs)
                print(f"{GREEN}✅ Pending cap now {n} — persisted.{RESET}")
            else:
                print(f"{RED}   pick 1–100{RESET}")
        except ValueError:
            print(f"{RED}   not a number — unchanged{RESET}")
    elif ans == '':
        print(f"{DIM}   unchanged{RESET}")
    else:
        print(f"{RED}   unknown option '{ans}' — unchanged{RESET}")


def show_release_notes(version):
    """Fetch and print the changelog for one Ollama release (e.g. '0.33.3')."""
    version = version.strip().lstrip('v')
    if not _parse_semver(version):
        print(f"{RED}⚠️  '{version}' doesn't look like a version number (try e.g. 'whatsnew 0.33.3'){RESET}")
        return
    try:
        data = _http_get_json(f"https://api.github.com/repos/ollama/ollama/releases/tags/v{version}")
    except Exception as e:
        print(f"{RED}⚠️  Could not fetch notes for v{version}: {e}{RESET}")
        return
    name = data.get('name') or f"v{version}"
    date = (data.get('published_at') or '')[:10]
    pre = " [pre-release]" if data.get('prerelease') else ""
    body = (data.get('body') or '').strip() or "(no release notes provided)"
    installed = _parse_semver(get_installed_ollama_version())
    ver = _parse_semver(version)
    if installed and ver:
        rel = (f"{GREEN}— this is your installed version{RESET}" if ver == installed else
               f"{ORANGE}— newer than your installed {installed[0]}.{installed[1]}.{installed[2]}{RESET}" if ver > installed else
               f"{DIM}— older than your installed version{RESET}")
    else:
        rel = ""
    print(f"\n{BOLD}📝 {name}{pre}{RESET}  {DIM}{date}{RESET}  {rel}")
    print(f"{DIM}{'─' * 60}{RESET}")
    for line in body.splitlines()[:60]:
        print(line)
    if len(body.splitlines()) > 60:
        print(f"{DIM}… truncated — full notes: https://github.com/ollama/ollama/releases/tag/v{version}{RESET}")
    print()


# --- Safety checklist -------------------------------------------------------

# Typo-squat guard: reject lookalikes of well-known packages
WELL_KNOWN_PACKAGES = ('requests', 'numpy', 'ollama', 'flask', 'fastapi')

def run_safety_checklist(candidate):
    """Return (is_safe, reasons). Every install candidate must pass all checks."""
    name = candidate.get('name', '')
    source = candidate.get('source', '')

    if source not in ('pypi', 'github', 'ollama_registry'):
        return False, [f"unknown source: {source}"]
    reasons = [f"source {source} is an official registry"]

    if source == 'github':
        health = fetch_github_repo_health(candidate.get('repo', ''))
        if not health or health['stars'] < 500:
            return False, [f"repo {candidate.get('repo')} has < 500 stars or is unreachable"]
        reasons.append(f"{health['stars']} stars on GitHub")
        if health['archived']:
            return False, [f"repo {candidate.get('repo')} is archived/unmaintained"]
        reasons.append("repo is actively maintained")

    # Typo-squat guard
    for known in WELL_KNOWN_PACKAGES:
        if name != known and re.fullmatch(re.escape(known) + r'[0o1lI]{1,3}', name):
            return False, [f"{name} looks like a typo-squat of {known}"]

    return True, reasons


# --- Actions ----------------------------------------------------------------

def install_package(pkg, force=False):
    """Install a PyPI package into the daisy venv. force=True overrides dry-run
    (used only when the user explicitly approves the item)."""
    venv_pip = os.path.expanduser('~/daisy_env/bin/pip')
    if not os.path.exists(venv_pip):
        return False, "venv pip not found"
    if not AUTO_INSTALL and not force:
        _log_print('⏸', f"DRY-RUN: would install '{pkg}' (set AUTO_INSTALL = True to allow)")
        return False, "dry-run"
    try:
        result = subprocess.run(
            [venv_pip, 'install', '--quiet', pkg],
            capture_output=True, text=True, timeout=120
        )
        ok = result.returncode == 0
        detail = 'installed' if ok else result.stderr.strip()[:200]
        _provisioner_log('pip_install', {'package': pkg, 'result': detail})
        return ok, detail
    except Exception as e:
        return False, str(e)


def pull_model(model, force=False):
    """Pull an Ollama model (internet download). force=True overrides dry-run
    (used only when the user explicitly approves the item)."""
    if not AUTO_INSTALL and not force:
        _log_print('⏸', f"DRY-RUN: would pull model '{model}' (set AUTO_INSTALL = True to allow)")
        return False, "dry-run"
    try:
        ollama.pull(model)
        _provisioner_log('model_pull', {'model': model, 'result': 'pulled'})
        _log_print('⬇️', f"pulled model {model}")
        return True, "pulled"
    except Exception as e:
        return False, str(e)


# --- Pending approvals: dry-run suggestions parked for the user to approve ---

def _load_pending():
    if os.path.exists(PROVISIONER_PENDING_FILE):
        try:
            with open(PROVISIONER_PENDING_FILE, 'r') as f:
                data = json.load(f)
            if isinstance(data, list):
                return data
        except Exception:
            pass
    return []


def _save_pending(items):
    try:
        with open(PROVISIONER_PENDING_FILE, 'w') as f:
            json.dump(items, f, indent=2)
    except Exception:
        pass


def queue_pending(candidate):
    """Park a vetted candidate for user approval. Returns True if newly parked."""
    items = _load_pending()
    if any(p.get('kind') == candidate.get('kind') and p.get('name') == candidate.get('name')
           for p in items):
        return False  # already parked
    if len(items) >= _pref('pending_max'):
        _provisioner_log('pending_overflow', {'dropped': candidate.get('name')})
        return False
    entry = dict(candidate)
    entry['proposed_at'] = datetime.now(timezone.utc).isoformat()
    items.append(entry)
    _save_pending(items)
    return True


def execute_candidate(cand):
    """Force-execute a user-approved candidate (overrides dry-run)."""
    if cand.get('kind') == 'pip':
        return install_package(cand['name'], force=True)
    if cand.get('kind') == 'model':
        return pull_model(cand['name'], force=True)
    return False, f"kind '{cand.get('kind')}' is not approvable"


def handle_approve():
    """Interactive one-by-one approval: y = yes, n = skip, a = all, s = stop."""
    global _provisioner_silent
    _provisioner_silent = True  # keep background thread output out of the prompt
    try:
        _handle_approve_inner()
    finally:
        _provisioner_silent = False

def _handle_approve_inner():
    items = _load_pending()
    if not items:
        print(f"{DIM}Nothing awaiting approval. Vetted suggestions park here automatically "
              f"when AUTO_INSTALL is off — run 'provisioner' to trigger research.{RESET}\n")
        return
    print(f"\n{BOLD}📝 {len(items)} suggestion(s) awaiting approval{RESET} "
          f"{DIM}(y = approve, n = skip, a = approve all, s = stop){RESET}")
    approve_all = False
    remaining, executed = [], 0
    for i, cand in enumerate(items, 1):
        safe, reasons = run_safety_checklist(cand)
        if not safe:
            print(f"{ORANGE}[{i}/{len(items)}]{RESET} {cand.get('name')}: "
                  f"{RED}auto-skipped — no longer passes the checklist ({'; '.join(reasons)}){RESET}")
            continue
        if not approve_all:
            print(f"\n{ORANGE}{BOLD}[{i}/{len(items)}]{RESET} {cand.get('kind')}: {BOLD}{cand.get('name')}{RESET}")
            print(f"{DIM}   reason: {cand.get('reason', '?')}{RESET}")
            print(f"   safety: ✅ {'; '.join(reasons)}")
            try:
                ans = input(f"{CYAN}   approve? [y/n/a/s]:{RESET} ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                print(f"\n{DIM}paused — remaining suggestions stay parked{RESET}")
                remaining.extend(items[i - 1:])
                break
            if ans == 's':
                remaining.extend(items[i - 1:])
                break
            if ans == 'n':
                remaining.append(cand)
                continue
            if ans == 'a':
                approve_all = True
            elif ans != 'y':
                remaining.append(cand)  # anything else = park it
                continue
        ok, detail = execute_candidate(cand)
        executed += bool(ok)
        print(f"{'✅' if ok else '⚠️ '} {cand.get('kind')} '{cand.get('name')}': {detail}")
        _provisioner_log('approved_execute', {'candidate': cand, 'result': detail})
    _save_pending(remaining)
    print(f"\n{BOLD}Done.{RESET} {executed} executed, {len(remaining)} still parked.\n")


def audit_stack():
    """Self-audit: can we import what we need? Is the server healthy? Disk OK?"""
    findings = []
    for mod in ('ollama', 'json'):
        try:
            importlib.import_module(mod)
            findings.append(f"{mod}: OK")
        except Exception as e:
            findings.append(f"{mod}: MISSING ({e})")
    try:
        disk = subprocess.run(['df', '-h', os.path.expanduser('~')],
                              capture_output=True, text=True, timeout=10)
        findings.append("disk: " + disk.stdout.strip().splitlines()[-1].split()[3] + " free")
    except Exception:
        pass
    if not check_ollama(silent=True):
        findings.append("ollama server: UNREACHABLE")
    return findings


# --- Sandbox repo auditor: clone -> static scan -> report. NOTHING is executed.

def _sandbox_jobs():
    """Load the persistent repo queue (file + curated, deduped)."""
    queued = []
    if os.path.exists(PROVISIONER_QUEUE_FILE):
        try:
            with open(PROVISIONER_QUEUE_FILE, 'r') as f:
                queued = [r for r in json.load(f) if isinstance(r, str)]
        except Exception:
            queued = []
    seen, merged = set(), []
    for repo in CURATED_REPOS + queued:
        if repo not in seen:
            seen.add(repo)
            merged.append(repo)
    return merged


def add_repo_job(repo):
    """Add a repo to the persistent audit queue (validated 'owner/name' format)."""
    repo = repo.strip()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        return False, "use the form 'owner/name' (e.g. 'pallets/flask')"
    queued = []
    if os.path.exists(PROVISIONER_QUEUE_FILE):
        try:
            with open(PROVISIONER_QUEUE_FILE, 'r') as f:
                queued = json.load(f)
        except Exception:
            queued = []
    if repo in CURATED_REPOS or repo in queued:
        return True, f"'{repo}' is already in the audit queue"
    queued.append(repo)
    try:
        with open(PROVISIONER_QUEUE_FILE, 'w') as f:
            json.dump(queued, f, indent=2)
        return True, f"'{repo}' added to the audit queue (next provisioner cycle audits it)"
    except Exception as e:
        return False, str(e)


def _sandbox_disk_mb():
    total = 0
    for root, _dirs, files in os.walk(SANDBOX_ROOT):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total / (1024 * 1024)


def clone_repo(repo):
    """Shallow-clone a repo into the sandbox. Only 'git' is ever executed."""
    safe_name = repo.replace('/', '__')
    dest = os.path.join(SANDBOX_ROOT, safe_name)
    if os.path.isdir(dest):
        return dest, "already cloned"
    os.makedirs(SANDBOX_ROOT, exist_ok=True)
    if _sandbox_disk_mb() > _pref('sandbox_max_disk_mb'):
        return None, f"sandbox over {_pref('sandbox_max_disk_mb')} MB cap; audit skipped"
    try:
        result = subprocess.run(
            ['git', 'clone', '--depth', '1', '--quiet', f"https://github.com/{repo}.git", dest],
            capture_output=True, text=True, timeout=180
        )
        if result.returncode != 0:
            return None, result.stderr.strip()[:200]
        return dest, "cloned"
    except Exception as e:
        return None, str(e)


def audit_repo_static(repo):
    """Shallow-clone + text-only scan. Never imports, runs or installs repo code."""
    dest, clone_status = clone_repo(repo)
    if not dest:
        return {'repo': repo, 'status': 'clone_failed', 'detail': clone_status,
                'findings': [], 'files_scanned': 0}

    findings, files_scanned = [], 0
    for root, dirs, files in os.walk(dest):
        dirs[:] = [d for d in dirs if d != '.git']  # skip git internals
        for fname in files:
            fpath = os.path.join(root, fname)
            # Scan only readable text-ish source files under 512 KB
            if os.path.getsize(fpath) > 512 * 1024:
                continue
            if not re.search(r"\.(py|js|ts|sh|bash|zsh|yaml|yml|toml|json|md|txt|env|cfg|ini|rb|go|rs)$",
                             fname, re.IGNORECASE) and not fname.startswith('.'):
                continue
            try:
                with open(fpath, 'r', encoding='utf-8', errors='ignore') as f:
                    for lineno, line in enumerate(f, 1):
                        for pattern, severity, desc in RISKY_PATTERNS:
                            if re.search(pattern, line):
                                rel = os.path.relpath(fpath, dest)
                                findings.append({
                                    'severity': severity, 'issue': desc,
                                    'file': rel, 'line': lineno,
                                })
            except OSError:
                continue
            files_scanned += 1

    critical = sum(1 for x in findings if x['severity'] == 'critical')
    high = sum(1 for x in findings if x['severity'] == 'high')
    report = {
        'repo': repo,
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'status': 'ok',
        'clone': clone_status,
        'files_scanned': files_scanned,
        'findings': findings[:50],  # cap report size
        'counts': {'critical': critical, 'high': high,
                   'total': len(findings)},
        'verdict': ('DO NOT USE' if critical else
                    'REVIEW BEFORE USE' if high else 'no serious risks found'),
    }
    _provisioner_log('repo_audit', {'repo': repo, 'verdict': report['verdict'],
                                    'counts': report['counts']})
    return report


def _save_repo_report(report):
    data = []
    if os.path.exists(PROVISIONER_REPORTS_FILE):
        try:
            with open(PROVISIONER_REPORTS_FILE, 'r') as f:
                data = json.load(f)
        except Exception:
            data = []
    if not isinstance(data, list):
        data = []
    data.append(report)
    try:
        with open(PROVISIONER_REPORTS_FILE, 'w') as f:
            json.dump(data, f, indent=2)
    except Exception:
        pass


def _repo_last_audited(repo):
    """Timestamp of the repo's last successful audit, or None."""
    if not os.path.exists(PROVISIONER_REPORTS_FILE):
        return None
    try:
        with open(PROVISIONER_REPORTS_FILE, 'r') as f:
            data = json.load(f)
        for report in reversed(data):
            if report.get('repo') == repo and report.get('status') == 'ok':
                return datetime.fromisoformat(report['timestamp'])
    except Exception:
        pass
    return None


def _due_repos():
    """Queued repos whose re-audit window has elapsed, oldest first, capped."""
    now = datetime.now(timezone.utc)
    reaudit_h = _pref('repo_reaudit_hours')
    due = []
    for repo in _sandbox_jobs():
        last = _repo_last_audited(repo)
        if last is None or (now - last).total_seconds() > reaudit_h * 3600:
            due.append((last or datetime.min.replace(tzinfo=timezone.utc), repo))
    due.sort()  # never-audited and stalest first
    prefs = _load_prefs()
    return [repo for _last, repo in due[:prefs['repos_per_cycle']]]


def audit_repo_line(repo):
    """Clone + static-audit a repo, save the report, return a colored verdict line."""
    report = audit_repo_static(repo)
    _save_repo_report(report)
    if report['status'] != 'ok':
        return f"{YELLOW}📦 {repo}: clone failed ({report.get('detail', '?')[:80]}){RESET}"
    c = report['counts']
    color = RED if c['critical'] else (YELLOW if c['high'] else GREEN)
    return (f"{color}📦 {repo}: {c['total']} finding(s) "
            f"({c['critical']} critical, {c['high']} high) — {report['verdict']}{RESET}")


def propose_tasks():
    """The Provisioner's brain: research the internet, propose concrete tasks."""
    tasks = []
    for suggestion in fetch_pypi_suggestions():
        inst = suggestion.get('installed')
        inst_note = f", installed is {inst}" if inst else " (not installed)"
        tasks.append({'kind': 'pip', 'name': suggestion['package'], 'source': 'pypi',
                      'reason': f"PyPI latest is {suggestion['latest']}{inst_note}"})
    for model in fetch_popular_ollama_models():
        tasks.append({'kind': 'model', 'name': model, 'source': 'ollama_registry',
                      'reason': 'useful model missing from local registry'})
    for repo in ('ollama/ollama', 'ollama/ollama-python'):
        health = fetch_github_repo_health(repo)
        if health and health['stars'] >= 500:
            tasks.append({'kind': 'audit', 'name': repo, 'repo': repo, 'source': 'github',
                          'reason': f"upstream repo healthy ({health['stars']} stars)"})
    return tasks


def provisioner_cycle():
    """One full autonomous cycle: research -> vet -> act, then sandbox repo audits."""
    _log_print('🔍', "researching online for useful additions...")
    alert_release(check_ollama_releases())
    try:
        alert_pypi(check_pypi_package_releases('ollama'))
    except Exception as e:
        _provisioner_log('pypi_alert_crash', str(e))
    candidates = propose_tasks()
    for cand in candidates:
        safe, reasons = run_safety_checklist(cand)
        verdict = "SAFE" if safe else "SKIP"
        _log_print('🛡', f"{cand['kind']} '{cand['name']}': {verdict} ({'; '.join(reasons)})")
        _provisioner_log('vetting', {'candidate': cand, 'safe': safe, 'reasons': reasons})
        if not safe:
            continue
        if cand['kind'] == 'pip':
            if AUTO_INSTALL:
                install_package(cand['name'])
            elif queue_pending(cand):
                _log_print('🅿️', f"parked '{cand['name']}' for approval (type 'approve')")
        elif cand['kind'] == 'model':
            if AUTO_INSTALL:
                pull_model(cand['name'])
            elif queue_pending(cand):
                _log_print('🅿️', f"parked '{cand['name']}' for approval (type 'approve')")
        elif cand['kind'] == 'audit':
            findings = audit_stack()
            _log_print('🩺', "stack audit: " + "; ".join(findings))

    # Sandbox repo audit queue (clones into ~/daisy_sandbox, TEXT-ONLY scan)
    for repo in _due_repos():
        if provisioner_stop.is_set():
            break
        _log_print('📦', f"auditing repo {repo} (sandbox, text-only)...")
        try:
            line = audit_repo_line(repo)
            if not _provisioner_silent:
                print(line)
        except Exception as e:
            _log_print('💥', f"repo audit crashed (caught): {e}")
            _provisioner_log('repo_audit_crash', {'repo': repo, 'error': str(e)})


def provisioner_loop():
    """Background thread main loop. Failures never crash the app."""
    _log_print('✅', f"autonomous agent online (cycle={_pref('cycle_seconds')}s, "
                     f"auto-install={'ON' if AUTO_INSTALL else 'DRY-RUN'})")
    provisioner_stop.wait(15)  # let the user's first prompt go first; avoid startup collisions
    while not provisioner_stop.is_set():
        try:
            run_provisioner_cycle()
        except Exception as e:
            _log_print('💥', f"cycle crashed (caught, continuing): {e}")
            _provisioner_log('cycle_crash', str(e))
        provisioner_stop.wait(_pref('cycle_seconds'))


provisioner_stop = threading.Event()
provisioner_cycle_lock = threading.Lock()  # never let two cycles overlap

def run_provisioner_cycle():
    """Lock-wrapped cycle entry point for both the thread and the manual command."""
    with provisioner_cycle_lock:
        provisioner_cycle()

# --- Tool library (function calling) -----------------------------------------
# Lets any worker agent call small, safe, deterministic tools mid-answer:
# the model emits a tool_calls request, we execute the real function and feed
# the result back so the model can continue. This closes the biggest feature
# gap found by the research daemon (Tool / function calling in Open WebUI,
# AnythingLLM and Jan) and fixes a real weakness of small models: arithmetic,
# current time, and file facts they cannot know.

TOOLS_ENABLED = True     # master switch — set False to run workers tool-less
MAX_TOOL_ROUNDS = 4      # agent-loop cap: model -> tool -> model -> ... -> answer
TOOL_OUTPUT_MAX = 4000   # chars of tool output fed back into the model

TOOL_HOME = os.path.expanduser("~")  # file tools never escape the home directory


def _safe_home_path(p):
    """Resolve a user-supplied path and refuse anything outside the home dir."""
    base = os.path.realpath(TOOL_HOME)
    full = os.path.realpath(os.path.join(base, str(p or ".")))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError("path outside the home directory is not allowed")
    return full


def _tool_calculate(expression=""):
    """Safe arithmetic via the ast module — no eval, no names, no attributes."""
    import ast
    import operator as op

    expression = str(expression).strip()[:200]
    if not expression:
        raise ValueError("empty expression")
    ops = {ast.Add: op.add, ast.Sub: op.sub, ast.Mult: op.mul, ast.Div: op.truediv,
           ast.FloorDiv: op.floordiv, ast.Mod: op.mod, ast.Pow: op.pow}

    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            return ops[type(node.op)](ev(node.left), ev(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
            v = ev(node.operand)
            return -v if isinstance(node.op, ast.USub) else +v
        raise ValueError(f"unsupported element: {ast.dump(node)[:60]}")

    result = ev(ast.parse(expression, mode="eval"))
    return f"{expression} = {result}"


def _tool_current_time():
    now = datetime.now()
    utc = datetime.now(timezone.utc)
    return (f"Local date/time: {now.strftime('%A, %Y-%m-%d %H:%M:%S')} | "
            f"UTC: {utc.strftime('%Y-%m-%d %H:%M:%S')}")


def _tool_read_file(path=""):
    full = _safe_home_path(path)
    if not os.path.isfile(full):
        raise ValueError(f"no such file: {path}")
    if os.path.getsize(full) > 100_000:
        raise ValueError("file larger than 100 KB — read a smaller file")
    with open(full, errors="replace") as f:
        text = f.read(TOOL_OUTPUT_MAX)
    return f"(contents of {path}, first {len(text)} chars)\n{text}"


def _tool_list_files(path="."):
    full = _safe_home_path(path)
    if not os.path.isdir(full):
        raise ValueError(f"not a directory: {path}")
    entries = sorted(os.listdir(full))[:100]
    lines = []
    for name in entries:
        sub = os.path.join(full, name)
        if os.path.isdir(sub):
            lines.append(f"{name}/")
        else:
            try:
                lines.append(f"{name} ({os.path.getsize(sub)} bytes)")
            except OSError:
                lines.append(name)
    return f"({len(entries)} entries in {path})\n" + "\n".join(lines)


def _tool_fetch_url(url=""):
    url = str(url).strip()
    if not url.startswith(("http://", "https://")):
        raise ValueError("only http(s) URLs are allowed")
    req = urllib.request.Request(url, headers={"User-Agent": "DaisyChain/1.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        raw = r.read(200_000).decode("utf-8", errors="replace")
    # crude tag-strip so the model gets text, not markup
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", " ", raw)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return f"(fetched {url})\n" + text[:TOOL_OUTPUT_MAX]


def _tool_search_documents(query=""):
    """RAG retrieval over the user's own indexed files (daisy_docs).
    Imported lazily so the engine works even if the docs module/index is
    missing. Returns the top chunks with their source file names."""
    import daisy_docs
    hits = daisy_docs.search_docs(query)
    if not hits:
        return ("No relevant passages found in the indexed documents. "
                "Tell the user you could not find this in their files — "
                "do NOT invent an answer.")
    parts = [f"[{i+1}] from '{h['file']}' (relevance {h['score']}):\n{h['text']}"
             for i, h in enumerate(hits)]
    return ("Passages from the user's own documents (cite the file name you "
            "used):\n\n" + "\n\n".join(parts))


# JSON-schema parameter descriptions handed to the model with each request
TOOLS = {
    "calculate": {
        "description": "Evaluate an arithmetic expression exactly (e.g. '1234*56', '(17+3)/4'). "
                       "Use this for ANY math beyond trivial single-digit sums.",
        "parameters": {"type": "object", "properties": {
            "expression": {"type": "string", "description": "arithmetic expression, e.g. 1234*56"}},
            "required": ["expression"]},
        "function": _tool_calculate,
    },
    "current_time": {
        "description": "Get today's date and the current local and UTC time.",
        "parameters": {"type": "object", "properties": {}},
        "function": _tool_current_time,
    },
    "read_file": {
        "description": "Read a text file from the home directory (max 100 KB). "
                       "Relative paths are resolved against home.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "file path, e.g. daisy_research/report.md"}},
            "required": ["path"]},
        "function": _tool_read_file,
    },
    "list_files": {
        "description": "List up to 100 entries of a directory in the home folder, with sizes.",
        "parameters": {"type": "object", "properties": {
            "path": {"type": "string", "description": "directory path, default home"}},
            "required": []},
        "function": _tool_list_files,
    },
    "fetch_url": {
        "description": "Download a web page and return its readable text (up to 4000 chars). "
                       "Use for looking up current facts on the internet.",
        "parameters": {"type": "object", "properties": {
            "url": {"type": "string", "description": "full http(s) URL"}},
            "required": ["url"]},
        "function": _tool_fetch_url,
    },
    "search_documents": {
        "description": "Search the user's own indexed documents (folder daisy_docs in the home "
                       "directory). Use whenever the user asks about their files, notes or "
                       "projects. Returns the most relevant passages with source file names.",
        "parameters": {"type": "object", "properties": {
            "query": {"type": "string", "description": "what to look for, phrased as a search query"}},
            "required": ["query"]},
        "function": _tool_search_documents,
    },
}


def get_tool_specs():
    """Tool specs in the dict form the ollama client expects for chat(tools=...)."""
    return [{"type": "function", "function": {"name": name, "description": t["description"],
                                              "parameters": t["parameters"]}}
            for name, t in TOOLS.items()]


def execute_tool(name, arguments):
    """Run a registered tool defensively. Returns (ok, output_text).
    Never raises: every failure becomes a text result the model can read."""
    tool = TOOLS.get(name)
    if not tool:
        return False, f"unknown tool '{name}'"
    if isinstance(arguments, str):          # some models send args as a JSON string
        try:
            arguments = json.loads(arguments) if arguments.strip() else {}
        except Exception:
            return False, "invalid arguments (not valid JSON)"
    if not isinstance(arguments, dict):
        return False, "invalid arguments (expected an object)"
    try:
        out = str(tool["function"](**arguments))
        return True, out[:TOOL_OUTPUT_MAX]
    except TypeError as e:
        return False, f"bad arguments for '{name}': {e}"
    except Exception as e:
        return False, f"tool '{name}' failed: {e}"


def run_worker_with_tools(worker_model, messages, on_token=None, on_tool=None):
    """The worker agent loop with function calling.

    Runs ollama.chat with the tool specs; whenever the model requests tool
    calls they are executed for real and the results are fed back, up to
    MAX_TOOL_ROUNDS rounds, then one final no-tools call forces an answer.

    on_token(text) fires for streamed answer/narration text; on_tool(name,
    args) fires the moment a tool call starts (before execution).
    Returns (final_answer, tool_events) where tool_events is a list of
    {'tool', 'args', 'ok', 'result'} dicts for logging and the UI.
    """
    tool_events = []
    if not TOOLS_ENABLED:
        response = ollama.chat(model=worker_model, messages=messages, stream=True)
        parts = []
        for chunk in response:
            tok = getattr(chunk.message, "content", "") or ""
            if tok:
                parts.append(tok)
                if on_token:
                    on_token(tok)
        return "".join(parts), tool_events

    specs = get_tool_specs()
    narrated = []                     # narration from earlier rounds must not be lost
    for _round in range(MAX_TOOL_ROUNDS):
        parts, tool_calls = [], []
        for chunk in ollama.chat(model=worker_model, messages=messages,
                                 tools=specs, stream=True):
            msg = getattr(chunk, "message", None)
            if msg is None:
                continue
            tok = msg.content or ""
            if tok:
                parts.append(tok)
                if on_token:
                    on_token(tok)
            for tc in (msg.tool_calls or []):
                # tolerate both pydantic objects (real client) and plain dicts
                tool_calls.append(tc.model_dump() if hasattr(tc, "model_dump") else dict(tc))

        if not tool_calls:
            return "".join(narrated + parts), tool_events   # the normal exit: a real answer

        if parts:
            narrated.append("".join(parts))
        # Replay the assistant's tool-call turn verbatim, then each result.
        messages.append({"role": "assistant", "content": "".join(parts),
                         "tool_calls": tool_calls})
        for tc in tool_calls:
            fn = tc.get("function", {})
            name = fn.get("name", "")
            args = fn.get("arguments") or {}
            if on_tool:
                on_tool(name, args)
            ok, out = execute_tool(name, args)
            tool_events.append({"tool": name, "args": args, "ok": ok, "result": out})
            messages.append({"role": "tool", "content": out, "tool_name": name})

    # Round cap hit — force a plain answer from what the model already has.
    messages.append({"role": "user",
                     "content": "Stop calling tools. Give your final answer now using the results you already have."})
    parts2 = []
    for chunk in ollama.chat(model=worker_model, messages=messages, stream=True):
        tok = getattr(getattr(chunk, "message", None), "content", "") or ""
        if tok:
            parts2.append(tok)
            if on_token:
                on_token(tok)
    if parts2:
        narrated.append("".join(parts2))
    return "\n".join(narrated), tool_events


def build_skill_system_message(skills):
    if not skills:
        return None
    blocks = [f"- {name}: {SKILLS[name]}" for name in skills]
    return "Apply these specialist skills while answering:\n" + "\n".join(blocks)


def execute_worker(target_route, user_prompt, skills=None):
    worker_model = AGENT_POOL.get(target_route, AGENT_POOL['general'])
    route_color = ROUTE_COLORS.get(target_route, RESET)
    print(f"{route_color}🚀 [Router] Routing workload to Agent: {target_route.upper()} ({worker_model}){RESET}")

    messages = [{'role': 'user', 'content': user_prompt}]
    system_msg = build_skill_system_message(skills)  # Broker's skills get injected here
    if system_msg:
        messages.insert(0, {'role': 'system', 'content': system_msg})

    def _announce_tool(name, args):
        brief = ", ".join(f"{k}={str(v)[:40]}" for k, v in list(args.items())[:3])
        print(f"{MAGENTA}🔧 [Agent] calling tool {name}({brief}){RESET}")

    answer, tool_events = run_worker_with_tools(worker_model, messages,
                                                on_tool=_announce_tool)
    return answer, worker_model, tool_events

def export_workload(prompt, category, model, output, skills=None, tools=None):
    filename = "agent_workload_exports.json"
    log_entry = {
        "timestamp": datetime.now().isoformat(),
        "input_prompt": prompt,
        "assigned_category": category,
        "executed_by_model": model,
        "skills_applied": skills or [],
        "tools_used": tools or [],
        "output": output
    }
    
    # Read existing or create new list
    if os.path.exists(filename):
        with open(filename, 'r') as f:
            try: data = json.load(f)
            except: data = []
    else:
        data = []
        
    data.append(log_entry)
    
    with open(filename, 'w') as f:
        json.dump(data, f, indent=4)
    print(f"{YELLOW}💾 [Exporter] Workload automatically exported to {filename}{RESET}")

# --- Run the Daisy Chain Workflow ---
VALID_ROUTES = set(AGENT_POOL)  # 'coding', 'general', 'fast_chat'

def check_ollama(silent=False):
    """Fail fast with a friendly message if the Ollama server isn't reachable."""
    try:
        ollama.list()
        return True
    except Exception as e:
        if not silent:
            print(f"{RED}❌ [Error] Can't reach the Ollama server.{RESET}")
            print("   Make sure the Ollama app is running (menu-bar icon), or start it with:")
            print("       ollama serve")
            print(f"{DIM}   (Details: {e}){RESET}")
        return False

def summarize_log(session_counts=None):
    """Print a colored summary of the export log, plus this session's stats."""
    filename = "agent_workload_exports.json"
    data = []
    if os.path.exists(filename):
        with open(filename, 'r') as f:
            try:
                data = json.load(f)
            except Exception:
                data = []
    if not isinstance(data, list):
        data = []

    print(f"\n{BOLD}📊 Export Log Summary{RESET}")

    if session_counts:
        total = sum(session_counts.values())
        parts = ", ".join(
            f"{ROUTE_COLORS.get(route, RESET)}{count} {route}{RESET}"
            for route, count in session_counts.items()
        )
        print(f"   This session: {BOLD}{total}{RESET} task(s) — {parts}")
    else:
        print("   This session: no tasks completed")

    if not data:
        print(f"{DIM}   All time: log file '{filename}' is empty or not created yet{RESET}\n")
        return

    by_route, by_model, by_skill = {}, {}, {}
    for entry in data:
        route = entry.get('assigned_category', 'unknown')
        by_route[route] = by_route.get(route, 0) + 1
        model = entry.get('executed_by_model', 'unknown')
        by_model[model] = by_model.get(model, 0) + 1
        for s in (entry.get('skills_applied') or []):
            by_skill[s] = by_skill.get(s, 0) + 1

    route_parts = ", ".join(
        f"{ROUTE_COLORS.get(route, RESET)}{count} {route}{RESET}"
        for route, count in sorted(by_route.items(), key=lambda item: -item[1])
    )
    print(f"   All time: {BOLD}{len(data)}{RESET} task(s) in '{filename}' — {route_parts}")

    model_parts = ", ".join(
        f"{BOLD}{count}x{RESET} {model}"
        for model, count in sorted(by_model.items(), key=lambda item: -item[1])
    )
    print(f"   By model: {model_parts}")

    if by_skill:
        skill_parts = ", ".join(
            f"{ORANGE}{BOLD}{count}x{RESET} {name}"
            for name, count in sorted(by_skill.items(), key=lambda item: -item[1])
        )
        print(f"   By skill: {skill_parts}")

    latest = data[-1]
    latest_prompt = str(latest.get('input_prompt', ''))
    prompt_preview = latest_prompt[:60] + ("…" if len(latest_prompt) > 60 else "")
    print(f"{DIM}   Latest entry: {latest.get('timestamp', '?')} — \"{prompt_preview}\"{RESET}\n")

if __name__ == "__main__":
    if not check_ollama():
        raise SystemExit(1)

    # The Provisioner: autonomous background agent (research / vet / act / audit)
    provisioner_thread = threading.Thread(target=provisioner_loop, name="provisioner", daemon=True)
    provisioner_thread.start()

    session_counts = {}
    print(f"{BOLD}🌀 Daisy Chain ready.{RESET} Type a task, 'prefs' for settings, 'du' for disk usage, 'cleanup' to free space, 'channels' to set the update channel, 'releases' for Ollama release history, 'approve' to review parked suggestions, 'repo owner/name' to queue a repo audit, 'provisioner' for the online agent, 'summary' for stats, or 'quit' to exit.\n")
    while True:
        try:
            parked = len(_load_pending())
            hint = f" {ORANGE}[{parked} awaiting approval — type 'approve']{RESET}" if parked else ""
            task = input(f"{CYAN}Enter a task for your local AI network (or 'quit'):{RESET}{hint} ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n👋 Session ended.")  # Ctrl-D / Ctrl-C exits cleanly
            provisioner_stop.set()
            summarize_log(session_counts)
            break

        if not task:
            continue
        command = task.lower()
        if command in ("quit", "exit"):
            print("👋 Session ended.")
            provisioner_stop.set()
            summarize_log(session_counts)
            break
        if command in ("du", "disk"):
            handle_du()
            continue
        if command in ("cleanup", "clean"):
            handle_cleanup()
            continue
        if command in ("prefs", "settings"):
            handle_prefs()
            continue
        if command in ("prefs --reset-prefs", "reset-prefs", "prefs reset"):
            handle_prefs(reset=True)
            continue
        if command in ("channels", "channel"):
            handle_channels()
            continue
        if command in ("releases", "release-history"):
            show_release_history()
            continue
        if command.startswith("whatsnew"):
            arg = command[len("whatsnew"):].strip()
            if not arg:
                print(f"{DIM}usage: whatsnew 0.33.3{RESET}")
            else:
                show_release_notes(arg)
            continue
        if command in ("approve", "review"):
            handle_approve()
            continue
        if command == 'repo' or command.startswith('repo '):
            arg = task[4:].strip()
            if not arg:
                queued = _sandbox_jobs()
                print(f"\n{BOLD}📦 Sandbox audit queue ({len(queued)}){RESET} — clone dir: {SANDBOX_ROOT}")
                for r in queued:
                    print(f"   • {r}")
                print(f"{DIM}   add one:  repo owner/name{RESET}\n")
            else:
                ok, msg = add_repo_job(arg)
                print(f"{'✅' if ok else '⚠️ '} {msg}")
            continue
        if command in ("provisioner", "agent"):
            try:
                alert_release(check_ollama_releases())  # fresh version status up front
                alert_pypi(check_pypi_package_releases('ollama'))
            except Exception:
                pass
            mode = 'ON (installs allowed)' if AUTO_INSTALL else 'OFF (dry-run)'
            print(f"\n{BOLD}🛠  Autonomous Provisioner{RESET} — AUTO_INSTALL={mode} · log: {PROVISIONER_LOG_FILE}")
            if _last_release_info:
                ri = _last_release_info
                ver = f"Ollama: {ri['installed'] or '?'} installed · {ri['latest']} on GitHub"
                ver += f" {ORANGE}{BOLD}(UPDATE AVAILABLE){RESET}" if ri['update_available'] else " (up to date)"
                print(f"{DIM}   {ver}{RESET}")
                if ri.get('prerelease_newer'):
                    print(f"{DIM}   🧪 Pre-release {ri['prerelease']} exists (experimental, ahead of stable){RESET}")
            try:
                pi = check_pypi_package_releases('ollama')
                if pi:
                    if pi.get('update_available'):
                        print(f"{DIM}   Python client: {pi['installed']} installed · {pi['latest']} on PyPI "
                              f"{ORANGE}{BOLD}(UPDATE AVAILABLE){RESET}")
                    elif pi.get('not_installed'):
                        print(f"{DIM}   Python client: not installed in this venv · PyPI has {pi['latest']}{RESET}")
                    else:
                        print(f"{DIM}   Python client: {pi['installed']} installed · PyPI {pi['latest']} (up to date){RESET}")
            except Exception:
                pass
            print(f"{DIM}   Each cycle: research online → vet with safety checklist → act → log.{RESET}")
            try:
                run_provisioner_cycle()
            except Exception as e:
                print(f"{RED}⚠️  Provisioner cycle failed: {e}{RESET}")
            print()
            continue
        if command in ("summary", "history", "stats"):
            summarize_log(session_counts)
            continue
        if command in ("skills", "broker"):
            print(f"\n{BOLD}🧰 Skill Library ({len(SKILLS)}){RESET} — the broker may attach up to {MAX_SKILLS_PER_TASK} per task:")
            for name, desc in SKILLS.items():
                print(f"   {ORANGE}• {name}{RESET}: {desc}")
            print()
            continue

        # Step 1: Filter & Route, Step 2: Execute
        start = time.perf_counter()
        try:
            assigned_route = filter_and_route(task)
            if assigned_route not in VALID_ROUTES:
                assigned_route = 'general'  # guard against a misclassified route

            skills = select_skills(task)
            if skills:
                print(f"{ORANGE}🧰 [Skill Broker] Attaching: {', '.join(skills)}{RESET}")
            else:
                print(f"{DIM}🧰 [Skill Broker] No special skills needed{RESET}")

            final_answer, model_used, tool_events = execute_worker(assigned_route, task, skills)
        except Exception as e:
            # Covers the server dying mid-session, model load errors, etc.
            print(f"{RED}⚠️  [Error] That task failed: {e}{RESET}")
            print(f"{DIM}   If Ollama isn't running anymore, restart it and try again.{RESET}\n")
            continue
        elapsed = time.perf_counter() - start

        # Step 3: Print Output to Terminal
        print(f"\n{BOLD}--- Final Output ---{RESET}")
        print(final_answer)
        print(f"{BOLD}--------------------{RESET}")

        # Step 4: Automatically Export Result
        try:
            export_workload(task, assigned_route, model_used, final_answer, skills,
                            tools=tool_events)
        except Exception as e:
            print(f"{RED}⚠️  [Exporter] Could not save the log entry: {e}{RESET}")

        # Colored receipt: which agent handled the task, and how long it took
        session_counts[assigned_route] = session_counts.get(assigned_route, 0) + 1
        route_color = ROUTE_COLORS.get(assigned_route, RESET)
        skill_note = f" · skills: {', '.join(skills)}" if skills else ""
        if tool_events:
            tnames = ", ".join(sorted({ev["tool"] for ev in tool_events}))
            skill_note += f" · tools: {tnames}"
        print(f"{route_color}✅ Handled by the {assigned_route} agent ({model_used}){skill_note} in {elapsed:.1f}s{RESET}\n")
