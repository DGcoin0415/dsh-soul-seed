# -*- coding: utf-8 -*-
"""dsh-soul-seed 参赛适配器（Bench 2.2）。

实现评测方要求的 System 接口：ingest / retrieve / mark / rewind。
检索用中文二元组 BM25 + 相对日期加权 + 最近 6 轮，不调模型（零额外成本）。
所有模型调用（如果以后加）都必须走 gw（评测网关）。
"""
import datetime
import math
import re

from bench22.systems import System, Retrieval

RUN_RE = re.compile(r"[一-鿿]+|[A-Za-z0-9]+")
RECENT = 6
TOP_K = 15
DAY = 86400


def tokens(text):
    t = str(text or "").lower()
    out = []
    for w in RUN_RE.findall(t):
        if re.fullmatch(r"[a-z0-9]+", w):
            out.append(w)
        else:
            # 中文按 2-gram 切
            for i in range(len(w) - 1):
                out.append(w[i:i + 2])
    return out


def _parse_iso(s):
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except Exception:
        return None


def relative_dates(question, now):
    """题目里的相对日期 → 绝对日期集合（用于给对应轮次加权）。"""
    now_dt = _parse_iso(now)
    if not now_dt:
        return set()
    out = set()
    q = question or ""
    if "昨天" in q:
        out.add((now_dt - datetime.timedelta(days=1)).date())
    if "前天" in q:
        out.add((now_dt - datetime.timedelta(days=2)).date())
    if "大前天" in q:
        out.add((now_dt - datetime.timedelta(days=3)).date())
    m = re.search(r"(\d+)\s*天前", q)
    if m:
        out.add((now_dt - datetime.timedelta(days=int(m.group(1)))).date())
    if "上周" in q or "上礼拜" in q:
        out.add((now_dt - datetime.timedelta(days=7)).date())
    w = re.search(r"上(?:周|礼拜)([一二三四五六日天])", q)
    if w:
        mp = {"一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
        target = mp[w.group(1)]
        d = now_dt.date()
        diff = (d.weekday() - target) % 7
        if diff == 0:
            diff = 7
        out.add(d - datetime.timedelta(days=diff + 7))
    return out


SYS_BASE = "你是用户长期聊天的伴侣，下面是你们过去的聊天片段和最近的对话，请根据记忆自然地回答用户这句话。"


def fmt(t):
    return f"[{t.get('time', '')}]\n用户：{t.get('user', '')}\n小满：{t.get('assistant', '')}"


class DshSoulSeed(System):
    name = "dsh-soul-seed"

    def __init__(self, gw):
        self.gw = gw
        self.turns = []
        self.docs = []

    # ---- 写入
    def ingest(self, turn):
        self.turns.append(turn)
        self.docs.append(tokens((turn.get("user") or "") + " " + (turn.get("assistant") or "")))

    # ---- 回退（自然用记忆榜）
    def mark(self):
        return len(self.turns)

    def rewind(self, token):
        del self.turns[token:]
        del self.docs[token:]

    # ---- 检索
    def retrieve(self, question, now, cutoff_turn, item_id=None):
        n = len(self.turns)
        if n == 0:
            return Retrieval(SYS_BASE, [])
        q = tokens(question)
        # BM25
        df = {}
        for d in self.docs:
            for w in set(d):
                df[w] = df.get(w, 0) + 1
        N = len(self.docs)
        avg = sum(len(d) for d in self.docs) / max(1, N)
        hints = relative_dates(question, now)
        scored = []
        for i, d in enumerate(self.docs):
            tf = {}
            for w in d:
                tf[w] = tf.get(w, 0) + 1
            s = 0.0
            for w in q:
                f = tf.get(w, 0)
                if not f:
                    continue
                idf = math.log(1 + (N - df.get(w, 0) + 0.5) / (df.get(w, 0) + 0.5))
                s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len(d) / max(1, avg)))
            if hints:
                dt = _parse_iso(self.turns[i].get("time"))
                if dt and dt.date() in hints:
                    s += 3
            scored.append((s, i))
        scored.sort(key=lambda x: -x[0])
        picks = sorted(i for s, i in scored[:TOP_K] if s > 0)
        if not picks:
            picks = list(range(max(0, n - TOP_K), n))
        recent = list(range(max(0, n - RECENT), n))
        blocks = [self.turns[i] for i in picks]
        parts = [SYS_BASE, "【过去的聊天片段】"] + [fmt(t) for t in blocks]
        parts += ["【最近的对话】"] + [fmt(self.turns[i]) for i in recent]
        used = sorted({self.turns[i].get("turn", i) for i in picks} | {self.turns[i].get("turn", i) for i in recent})
        return Retrieval("\n\n".join(parts), used, {"picked": [self.turns[i].get("turn") for i in picks]})
