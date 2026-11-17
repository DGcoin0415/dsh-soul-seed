# -*- coding: utf-8 -*-
"""dsh-soul-seed 参赛适配器（Bench 2.2）。

实现评测方要求的 System 接口：ingest / retrieve / mark / rewind。

检索链路（与报名清单一致）：
  1) 中文二元组 BM25 粗筛 top-40（本地、免费）
  2) 调网关向量模型 qwen3.7-text-embedding 对候选做余弦精排
  3) 调网关重排模型 qwen3.7-text-rerank 收敛到 top-10
  4) 加最近 6 轮

成本控制：ingest 阶段不调模型（历史可能上万轮）；模型调用只发生在 retrieve，
且只对 BM25 粗筛出来的候选做，每题约 1 次 query embedding + 1 批 document
embedding + 1 次 rerank。网关调用失败时自动退回纯 BM25，不会把整轮跑挂。
"""
import datetime
import math
import re

from bench22.systems import System, Retrieval

RUN_RE = re.compile(r"[一-鿿]+|[A-Za-z0-9]+")
RECENT = 6
POOL = 40      # BM25 粗筛候选数
TOP_K = 10     # 最终注入的记忆片段数
DAY = 86400


def tokens(text):
    t = str(text or "").lower()
    out = []
    for w in RUN_RE.findall(t):
        if re.fullmatch(r"[a-z0-9]+", w):
            out.append(w)
        else:
            for i in range(len(w) - 1):
                out.append(w[i:i + 2])
    return out


def doc_text(turn):
    return "用户：" + str(turn.get("user") or "") + "\n小满：" + str(turn.get("assistant") or "")


def cos(a, b):
    s = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        s += x * y
        na += x * x
        nb += y * y
    d = math.sqrt(na) * math.sqrt(nb)
    return s / d if d else 0.0


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
        self.texts = []

    # ---- 写入（只做本地索引，不调模型）
    def ingest(self, turn):
        self.turns.append(turn)
        txt = doc_text(turn)
        self.texts.append(txt)
        self.docs.append(tokens(txt))

    # ---- 回退（自然用记忆榜）
    def mark(self):
        return len(self.turns)

    def rewind(self, token):
        del self.turns[token:]
        del self.docs[token:]
        del self.texts[token:]

    # ---- BM25 粗筛
    def _bm25(self, question, now):
        n = len(self.docs)
        if n == 0:
            return []
        q = tokens(question)
        df = {}
        for d in self.docs:
            for w in set(d):
                df[w] = df.get(w, 0) + 1
        avg = sum(len(d) for d in self.docs) / max(1, n)
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
                idf = math.log(1 + (n - df.get(w, 0) + 0.5) / (df.get(w, 0) + 0.5))
                s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * len(d) / max(1, avg)))
            if hints:
                dt = _parse_iso(self.turns[i].get("time"))
                if dt and dt.date() in hints:
                    s += 3
            if s > 0:
                scored.append((s, i))
        scored.sort(key=lambda x: -x[0])
        return [i for _, i in scored[:POOL]]

    def retrieve(self, question, now, cutoff_turn, item_id=None):
        n = len(self.turns)
        if n == 0:
            return Retrieval(SYS_BASE, [])

        cand = self._bm25(question, now)
        picks = cand[:TOP_K]

        # ---- 向量精排（走网关；失败就退回 BM25 顺序）
        if cand:
            try:
                qv = self.gw.embed([question], "retrieve", tag="q", query=True)[0]
                dvs = self.gw.embed([self.texts[i] for i in cand], "retrieve", tag="d")
                ranked = sorted(zip(cand, dvs), key=lambda x: -cos(qv, x[1]))
                picks = [i for i, _ in ranked[:POOL]]
            except Exception:
                picks = cand[:TOP_K]

        # ---- 重排收敛（走网关；同样失败就退回）
        if len(picks) > TOP_K:
            try:
                res = self.gw.rerank(question, [self.texts[i] for i in picks], "retrieve", tag="r")
                order = sorted(res, key=lambda r: -float(r.get("relevance_score", 0)))
                picks = [picks[int(r["index"])] for r in order][:TOP_K]
            except Exception:
                picks = picks[:TOP_K]
        picks = sorted(picks[:TOP_K])

        if not picks:
            picks = list(range(max(0, n - TOP_K), n))
        recent = list(range(max(0, n - RECENT), n))

        parts = [SYS_BASE, "【过去的聊天片段】"] + [fmt(self.turns[i]) for i in picks]
        parts += ["【最近的对话】"] + [fmt(self.turns[i]) for i in recent]
        used = sorted({self.turns[i].get("turn", i) for i in picks} | {self.turns[i].get("turn", i) for i in recent})
        return Retrieval("\n\n".join(parts), used,
                         {"picked": [self.turns[i].get("turn") for i in picks],
                          "pool": len(cand)})
