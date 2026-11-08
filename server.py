#!/usr/bin/env python3
"""The Egg — loja virtual de ovos.
Servidor sem dependências externas: http.server + sqlite3.
Rodar:  python3 server.py   (porta 8000)
Admin padrão:  admin@theegg.com / admin123  (troque após o primeiro acesso!)
"""
import hashlib, hmac, json, mimetypes, os, secrets, sqlite3, time
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DB_PATH = os.environ.get("THEEGG_DB", os.path.join(BASE, "theegg.db"))
PORT = int(os.environ.get("PORT", "8000"))
SESSION_DAYS = 14

STATUS_FLOW = [
    ("realizado", "Pedido realizado"),
    ("pago", "Pagamento confirmado"),
    ("preparo", "Pedido em preparação"),
    ("entrega", "Saiu para entrega"),
    ("entregue", "Pedido entregue"),
]
STATUS_KEYS = [s[0] for s in STATUS_FLOW]
PAYMENTS = ["Pix", "Dinheiro na entrega", "Cartão na entrega"]


def now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys=ON")
    return c


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt), 200_000).hex()
    return f"{salt}${h}"


def check_pw(pw, stored):
    salt, _ = stored.split("$")
    return hmac.compare_digest(hash_pw(pw, salt), stored)


def init_db():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY, name TEXT, email TEXT UNIQUE, phone TEXT,
      pw TEXT, is_admin INTEGER DEFAULT 0, created TEXT);
    CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY, user_id INTEGER, expires TEXT);
    CREATE TABLE IF NOT EXISTS resets(
      token TEXT PRIMARY KEY, user_id INTEGER, expires TEXT, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS products(
      id INTEGER PRIMARY KEY, name TEXT, kind TEXT, eggs INTEGER, price_cents INTEGER,
      promo_price_cents INTEGER, image TEXT, description TEXT, stock INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS zones(
      id INTEGER PRIMARY KEY, name TEXT UNIQUE, fee_cents INTEGER);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS orders(
      id INTEGER PRIMARY KEY, user_id INTEGER, created TEXT, status TEXT,
      status_updated TEXT, name TEXT, phone TEXT, street TEXT, number TEXT,
      neighborhood TEXT, complement TEXT, payment TEXT,
      subtotal_cents INTEGER, fee_cents INTEGER, total_cents INTEGER);
    CREATE TABLE IF NOT EXISTS order_items(
      id INTEGER PRIMARY KEY, order_id INTEGER, product_id INTEGER, name TEXT,
      kind TEXT, eggs INTEGER, qty INTEGER, unit_cents INTEGER);
    CREATE TABLE IF NOT EXISTS order_events(
      id INTEGER PRIMARY KEY, order_id INTEGER, status TEXT, at TEXT);
    """)
    if not c.execute("SELECT 1 FROM users WHERE is_admin=1").fetchone():
        c.execute("INSERT INTO users(name,email,phone,pw,is_admin,created) VALUES(?,?,?,?,1,?)",
                  ("Administrador", "admin@theegg.com", "", hash_pw("admin123"), now()))
    if not c.execute("SELECT 1 FROM products").fetchone():
        seed = [
            ("Ovo Unidade", "unidade", 1, 100, None, "/img/prod-unidade.svg",
             "Um ovo fresquinho, perfeito para quem quer só um pouco.", 300),
            ("Dúzia de Ovos", "duzia", 12, 1200, 1090, "/img/prod-duzia.svg",
             "12 ovos selecionados, embalagem protetora.", 120),
            ("Cartela com 20 Ovos", "vinte", 20, 1900, 1690, "/img/prod-vinte.svg",
             "A melhor economia para a família: 20 ovos frescos.", 80),
        ]
        c.executemany("INSERT INTO products(name,kind,eggs,price_cents,promo_price_cents,image,description,stock) VALUES(?,?,?,?,?,?,?,?)", seed)
    if not c.execute("SELECT 1 FROM zones").fetchone():
        c.executemany("INSERT INTO zones(name,fee_cents) VALUES(?,?)",
                      [("Centro", 500), ("Zona Norte", 800), ("Zona Sul", 800), ("Outros bairros", 1200)])
    c.execute("INSERT OR IGNORE INTO settings VALUES('default_fee_cents','1000')")
    c.execute("INSERT OR IGNORE INTO settings VALUES('free_shipping_cents','0')")
    c.commit(); c.close()


class ApiError(Exception):
    def __init__(self, msg, code=400):
        self.msg, self.code = msg, code


def row(r):
    return dict(r) if r else None


def product_json(p):
    d = dict(p)
    d["effective_cents"] = d["promo_price_cents"] if d["promo_price_cents"] else d["price_cents"]
    return d


def fee_for(c, neighborhood):
    n = (neighborhood or "").strip().lower()
    z = c.execute("SELECT fee_cents FROM zones WHERE lower(name)=?", (n,)).fetchone()
    if z:
        return z["fee_cents"]
    return int(c.execute("SELECT value FROM settings WHERE key='default_fee_cents'").fetchone()["value"])


def order_json(c, o, admin=False):
    d = dict(o)
    d["items"] = [dict(i) for i in c.execute("SELECT * FROM order_items WHERE order_id=?", (o["id"],))]
    d["eggs_total"] = sum(i["eggs"] * i["qty"] for i in d["items"])
    d["events"] = [dict(e) for e in c.execute("SELECT status,at FROM order_events WHERE order_id=? ORDER BY id", (o["id"],))]
    if admin:
        u = c.execute("SELECT email FROM users WHERE id=?", (o["user_id"],)).fetchone()
        d["email"] = u["email"] if u else ""
    return d


class H(BaseHTTPRequestHandler):
    server_version = "TheEgg/1.0"

    def log_message(self, *a):
        pass

    # ---------- helpers ----------
    def send_json(self, obj, code=200, headers=None):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 6_000_000:
            raise ApiError("Corpo grande demais", 413)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except Exception:
            raise ApiError("JSON inválido")

    def user(self, c):
        ck = self.headers.get("Cookie", "")
        tok = None
        for part in ck.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "sid":
                tok = v
        if not tok:
            return None
        r = c.execute("""SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
                         WHERE s.token=? AND s.expires>?""", (tok, now())).fetchone()
        return r

    def require(self, c, admin=False):
        u = self.user(c)
        if not u:
            raise ApiError("Faça login para continuar.", 401)
        if admin and not u["is_admin"]:
            raise ApiError("Acesso restrito ao administrador.", 403)
        return u

    # ---------- dispatch ----------
    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        p = urlparse(self.path)
        path = p.path
        if path.startswith("/api/"):
            c = db()
            try:
                self.api(c, method, path[5:].strip("/").split("/"), parse_qs(p.query))
            except ApiError as e:
                self.send_json({"error": e.msg}, e.code)
            except Exception as e:  # noqa
                import traceback; traceback.print_exc()
                self.send_json({"error": "Erro interno do servidor"}, 500)
            finally:
                c.close()
        elif method == "GET":
            self.static(path)
        else:
            self.send_json({"error": "Não encontrado"}, 404)

    def static(self, path):
        if path == "/" or "." not in os.path.basename(path):
            path = "/index.html"
        fp = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not fp.startswith(STATIC) or not os.path.isfile(fp):
            self.send_response(404); self.end_headers(); return
        data = open(fp, "rb").read()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(fp)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    # ---------- API ----------
    def api(self, c, m, parts, q):
        a = parts[0]
        b = parts[1] if len(parts) > 1 else None

        # público
        if a == "catalog" and m == "GET":
            prods = [product_json(p) for p in c.execute("SELECT * FROM products WHERE active=1 ORDER BY eggs")]
            zones = [dict(z) for z in c.execute("SELECT * FROM zones ORDER BY name")]
            s = {r["key"]: r["value"] for r in c.execute("SELECT * FROM settings")}
            return self.send_json({"products": prods, "zones": zones,
                                   "default_fee_cents": int(s["default_fee_cents"]),
                                   "free_shipping_cents": int(s["free_shipping_cents"]),
                                   "payments": PAYMENTS})
        if a == "fee" and m == "GET":
            return self.send_json({"fee_cents": fee_for(c, (q.get("n") or [""])[0])})

        # auth
        if a == "register" and m == "POST":
            d = self.body()
            name, email, pw = (d.get("name") or "").strip(), (d.get("email") or "").strip().lower(), d.get("password") or ""
            if len(name) < 2 or "@" not in email or len(pw) < 6:
                raise ApiError("Informe nome, e-mail válido e senha com ao menos 6 caracteres.")
            if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                raise ApiError("Este e-mail já está cadastrado.", 409)
            cur = c.execute("INSERT INTO users(name,email,phone,pw,created) VALUES(?,?,?,?,?)",
                            (name, email, (d.get("phone") or "").strip(), hash_pw(pw), now()))
            c.commit()
            return self.login_ok(c, cur.lastrowid)
        if a == "login" and m == "POST":
            d = self.body()
            u = c.execute("SELECT * FROM users WHERE email=?", ((d.get("email") or "").strip().lower(),)).fetchone()
            if not u or not check_pw(d.get("password") or "", u["pw"]):
                raise ApiError("E-mail ou senha incorretos.", 401)
            return self.login_ok(c, u["id"])
        if a == "logout" and m == "POST":
            for part in self.headers.get("Cookie", "").split(";"):
                k, _, v = part.strip().partition("=")
                if k == "sid":
                    c.execute("DELETE FROM sessions WHERE token=?", (v,)); c.commit()
            return self.send_json({"ok": True}, headers={"Set-Cookie": "sid=; Path=/; Max-Age=0"})
        if a == "me" and m == "GET":
            u = self.user(c)
            return self.send_json({"user": self.pub_user(u) if u else None})
        if a == "forgot" and m == "POST":
            email = (self.body().get("email") or "").strip().lower()
            u = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
            out = {"ok": True, "message": "Se o e-mail existir, enviamos as instruções de recuperação."}
            if u:
                tok = secrets.token_urlsafe(24)
                c.execute("INSERT INTO resets VALUES(?,?,?,0)", (tok, u["id"], (datetime.now() + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")))
                c.commit()
                # Sem serviço de e-mail configurado: o código é impresso no console do servidor.
                print(f"[RECUPERAÇÃO DE SENHA] {email}: código {tok}")
                if os.environ.get("THEEGG_DEV_RESET") == "1":
                    out["dev_token"] = tok
            return self.send_json(out)
        if a == "reset" and m == "POST":
            d = self.body()
            r = c.execute("SELECT * FROM resets WHERE token=? AND used=0 AND expires>?", (d.get("token", ""), now())).fetchone()
            if not r or len(d.get("password") or "") < 6:
                raise ApiError("Código inválido/expirado ou senha curta (mín. 6).")
            c.execute("UPDATE users SET pw=? WHERE id=?", (hash_pw(d["password"]), r["user_id"]))
            c.execute("UPDATE resets SET used=1 WHERE token=?", (r["token"],))
            c.execute("DELETE FROM sessions WHERE user_id=?", (r["user_id"],))
            c.commit()
            return self.send_json({"ok": True})

        # cliente
        if a == "account" and m == "PUT":
            u = self.require(c)
            d = self.body()
            name, phone = (d.get("name") or u["name"]).strip(), (d.get("phone") or "").strip()
            if len(name) < 2:
                raise ApiError("Nome inválido.")
            if d.get("new_password"):
                if not check_pw(d.get("current_password") or "", u["pw"]):
                    raise ApiError("Senha atual incorreta.", 403)
                if len(d["new_password"]) < 6:
                    raise ApiError("Nova senha muito curta.")
                c.execute("UPDATE users SET pw=? WHERE id=?", (hash_pw(d["new_password"]), u["id"]))
            c.execute("UPDATE users SET name=?, phone=? WHERE id=?", (name, phone, u["id"]))
            c.commit()
            return self.send_json({"user": self.pub_user(c.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone())})
        if a == "orders" and m == "POST":
            return self.create_order(c)
        if a == "orders" and m == "GET":
            u = self.require(c)
            rows = c.execute("SELECT * FROM orders WHERE user_id=? ORDER BY id DESC", (u["id"],)).fetchall()
            return self.send_json({"orders": [order_json(c, o) for o in rows], "flow": STATUS_FLOW})

        # admin
        if a == "admin":
            self.require(c, admin=True)
            return self.admin(c, m, parts[1:], q)
        raise ApiError("Rota não encontrada", 404)

    def pub_user(self, u):
        return {"id": u["id"], "name": u["name"], "email": u["email"], "phone": u["phone"], "is_admin": bool(u["is_admin"])}

    def login_ok(self, c, uid):
        tok = secrets.token_urlsafe(32)
        exp = (datetime.now() + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("INSERT INTO sessions VALUES(?,?,?)", (tok, uid, exp))
        c.commit()
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        self.send_json({"user": self.pub_user(u)},
                       headers={"Set-Cookie": f"sid={tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS*86400}"})

    def create_order(self, c):
        u = self.require(c)
        d = self.body()
        req = {"name": "Nome completo", "phone": "Telefone", "street": "Endereço", "neighborhood": "Bairro",
               "number": "Número", "payment": "Forma de pagamento"}
        for k, label in req.items():
            if not str(d.get(k) or "").strip():
                raise ApiError(f"Preencha o campo obrigatório: {label}.")
        if d["payment"] not in PAYMENTS:
            raise ApiError("Forma de pagamento inválida.")
        items = d.get("items") or []
        if not items:
            raise ApiError("Sua sacola está vazia.")
        c.execute("BEGIN IMMEDIATE")
        try:
            lines, subtotal = [], 0
            for it in items:
                qty = int(it.get("qty") or 0)
                p = c.execute("SELECT * FROM products WHERE id=? AND active=1", (it.get("product_id"),)).fetchone()
                if not p or qty < 1:
                    raise ApiError("Produto inválido na sacola.")
                if p["stock"] < qty:
                    raise ApiError(f"Estoque insuficiente de “{p['name']}” (restam {p['stock']}).", 409)
                unit = p["promo_price_cents"] or p["price_cents"]   # preço SEMPRE vem do banco
                subtotal += unit * qty
                lines.append((p, qty, unit))
            fee = fee_for(c, d["neighborhood"])
            free = int(c.execute("SELECT value FROM settings WHERE key='free_shipping_cents'").fetchone()["value"])
            if free and subtotal >= free:
                fee = 0
            ts = now()
            cur = c.execute("""INSERT INTO orders(user_id,created,status,status_updated,name,phone,street,number,
                neighborhood,complement,payment,subtotal_cents,fee_cents,total_cents) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (u["id"], ts, "realizado", ts, d["name"].strip(), d["phone"].strip(), d["street"].strip(),
                             str(d["number"]).strip(), d["neighborhood"].strip(), (d.get("complement") or "").strip(),
                             d["payment"], subtotal, fee, subtotal + fee))
            oid = cur.lastrowid
            for p, qty, unit in lines:
                c.execute("INSERT INTO order_items(order_id,product_id,name,kind,eggs,qty,unit_cents) VALUES(?,?,?,?,?,?,?)",
                          (oid, p["id"], p["name"], p["kind"], p["eggs"], qty, unit))
                c.execute("UPDATE products SET stock=stock-? WHERE id=?", (qty, p["id"]))
            c.execute("INSERT INTO order_events(order_id,status,at) VALUES(?,?,?)", (oid, "realizado", ts))
            c.commit()
        except Exception:
            c.rollback()
            raise
        o = c.execute("SELECT * FROM orders WHERE id=?", (oid,)).fetchone()
        self.send_json({"order": order_json(c, o)}, 201)

    def admin(self, c, m, parts, q):
        a = parts[0] if parts else ""
        rid = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None

        if a == "stats" and m == "GET":
            r = c.execute("""SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) rev, COALESCE(SUM(subtotal_cents),0) prod,
                             COALESCE(SUM(fee_cents),0) fees FROM orders""").fetchone()
            by = [dict(x) for x in c.execute("SELECT status, COUNT(*) n FROM orders GROUP BY status")]
            days = [dict(x) for x in c.execute("""SELECT substr(created,1,10) day, COUNT(*) n, SUM(total_cents) total
                    FROM orders GROUP BY day ORDER BY day DESC LIMIT 14""")]
            eggs = c.execute("SELECT COALESCE(SUM(eggs*qty),0) e FROM order_items").fetchone()["e"]
            cust = c.execute("SELECT COUNT(*) n FROM users WHERE is_admin=0").fetchone()["n"]
            return self.send_json({"orders": r["n"], "revenue_cents": r["rev"], "products_cents": r["prod"],
                                   "fees_cents": r["fees"], "eggs": eggs, "customers": cust, "by_status": by, "days": days})

        if a == "orders":
            if m == "GET":
                st = (q.get("status") or [""])[0]
                rows = c.execute("SELECT * FROM orders" + (" WHERE status=?" if st else "") + " ORDER BY id DESC",
                                 (st,) if st else ()).fetchall()
                return self.send_json({"orders": [order_json(c, o, True) for o in rows], "flow": STATUS_FLOW})
            if m == "PUT" and rid:
                st = self.body().get("status")
                if st not in STATUS_KEYS:
                    raise ApiError("Status inválido.")
                ts = now()
                c.execute("UPDATE orders SET status=?, status_updated=? WHERE id=?", (st, ts, rid))
                c.execute("INSERT INTO order_events(order_id,status,at) VALUES(?,?,?)", (rid, st, ts))
                c.commit()
                o = c.execute("SELECT * FROM orders WHERE id=?", (rid,)).fetchone()
                if not o:
                    raise ApiError("Pedido não encontrado.", 404)
                return self.send_json({"order": order_json(c, o, True)})

        if a == "products":
            if m == "GET":
                return self.send_json({"products": [product_json(p) for p in c.execute("SELECT * FROM products ORDER BY eggs, id")]})
            d = self.body() if m in ("POST", "PUT") else {}
            if m in ("POST", "PUT"):
                kind = d.get("kind")
                eggs = {"unidade": 1, "duzia": 12, "vinte": 20}.get(kind)
                if not eggs:
                    raise ApiError("Formato deve ser unidade, duzia ou vinte.")
                name = (d.get("name") or "").strip()
                if not name:
                    raise ApiError("Informe o nome do produto.")
                try:
                    price = int(round(float(d.get("price")) * 100))
                    promo = int(round(float(d["promo_price"]) * 100)) if d.get("promo_price") not in (None, "", 0, "0") else None
                    stock = int(d.get("stock") or 0)
                except Exception:
                    raise ApiError("Preço/estoque inválidos.")
                if price <= 0 or stock < 0 or (promo is not None and promo <= 0):
                    raise ApiError("Preço/estoque inválidos.")
                image = d.get("image") or ""
                if image.startswith("data:image/"):
                    image = self.save_image(image)
            if m == "POST":
                c.execute("INSERT INTO products(name,kind,eggs,price_cents,promo_price_cents,image,description,stock,active) VALUES(?,?,?,?,?,?,?,?,1)",
                          (name, kind, eggs, price, promo, image or f"/img/prod-{kind}.svg", d.get("description") or "", stock))
                c.commit()
                return self.send_json({"ok": True}, 201)
            if m == "PUT" and rid:
                cur_img = c.execute("SELECT image FROM products WHERE id=?", (rid,)).fetchone()
                c.execute("""UPDATE products SET name=?,kind=?,eggs=?,price_cents=?,promo_price_cents=?,image=?,description=?,stock=?,active=?
                             WHERE id=?""", (name, kind, eggs, price, promo, image or (cur_img["image"] if cur_img else ""),
                                              d.get("description") or "", stock, 1 if d.get("active", True) else 0, rid))
                c.commit()
                return self.send_json({"ok": True})
            if m == "DELETE" and rid:
                c.execute("UPDATE products SET active=0 WHERE id=?", (rid,))  # preserva histórico de pedidos
                c.commit()
                return self.send_json({"ok": True})

        if a == "zones":
            if m == "GET":
                s = {r["key"]: r["value"] for r in c.execute("SELECT * FROM settings")}
                return self.send_json({"zones": [dict(z) for z in c.execute("SELECT * FROM zones ORDER BY name")],
                                       "default_fee_cents": int(s["default_fee_cents"]), "free_shipping_cents": int(s["free_shipping_cents"])})
            if m == "POST":
                d = self.body()
                name = (d.get("name") or "").strip()
                try:
                    fee = int(round(float(d.get("fee")) * 100))
                except Exception:
                    raise ApiError("Taxa inválida.")
                if not name or fee < 0:
                    raise ApiError("Informe bairro/região e taxa válida.")
                c.execute("INSERT INTO zones(name,fee_cents) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET fee_cents=excluded.fee_cents", (name, fee))
                c.commit()
                return self.send_json({"ok": True}, 201)
            if m == "DELETE" and rid:
                c.execute("DELETE FROM zones WHERE id=?", (rid,)); c.commit()
                return self.send_json({"ok": True})
            if m == "PUT":
                d = self.body()
                try:
                    c.execute("UPDATE settings SET value=? WHERE key='default_fee_cents'", (str(int(round(float(d["default_fee"]) * 100))),))
                    c.execute("UPDATE settings SET value=? WHERE key='free_shipping_cents'", (str(int(round(float(d.get("free_shipping") or 0) * 100))),))
                except Exception:
                    raise ApiError("Valores inválidos.")
                c.commit()
                return self.send_json({"ok": True})

        if a == "customers" and m == "GET":
            rows = c.execute("""SELECT u.id,u.name,u.email,u.phone,u.created,COUNT(o.id) orders,COALESCE(SUM(o.total_cents),0) spent
                                FROM users u LEFT JOIN orders o ON o.user_id=u.id WHERE u.is_admin=0 GROUP BY u.id ORDER BY u.id DESC""")
            return self.send_json({"customers": [dict(r) for r in rows]})
        raise ApiError("Rota não encontrada", 404)

    def save_image(self, data_url):
        head, _, b64 = data_url.partition(",")
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(head.split(";")[0][5:])
        if not ext:
            raise ApiError("Formato de imagem não suportado (use PNG, JPG ou WebP).")
        import base64
        raw = base64.b64decode(b64)
        if len(raw) > 4_000_000:
            raise ApiError("Imagem maior que 4 MB.")
        name = f"up-{secrets.token_hex(6)}.{ext}"
        os.makedirs(os.path.join(STATIC, "uploads"), exist_ok=True)
        open(os.path.join(STATIC, "uploads", name), "wb").write(raw)
        return f"/uploads/{name}"


if __name__ == "__main__":
    init_db()
    print(f"The Egg rodando em http://localhost:{PORT}  (admin: admin@theegg.com / admin123)")
    ThreadingHTTPServer(("0.0.0.0", PORT), H).serve_forever()
