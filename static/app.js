/* The Egg — front-end (SPA com rotas por hash) */
const $ = (s, el = document) => el.querySelector(s);
const app = $("#app");
const money = c => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const fmtDate = s => { if (!s) return ""; const d = new Date(s.replace(" ", "T")); return d.toLocaleDateString("pt-BR") + " às " + d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); };
const KIND = { unidade: "Unidade (1 ovo)", duzia: "Dúzia (12 ovos)", vinte: "Cartela com 20 ovos" };

let state = { user: null, catalog: null, cart: JSON.parse(localStorage.getItem("egg_cart") || "[]") };

async function api(path, method = "GET", body) {
  const r = await fetch("/api/" + path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "Erro"); e.code = r.status; throw e; }
  return j;
}
function toast(msg, bad) { const t = $("#toast"); t.textContent = msg; t.className = "show" + (bad ? " bad" : ""); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = "", 2800); }
const saveCart = () => { localStorage.setItem("egg_cart", JSON.stringify(state.cart)); updateBadge(); };
function updateBadge() { const n = state.cart.reduce((a, i) => a + i.qty, 0); const b = $("#cartCount"); b.textContent = n; b.hidden = !n; }
const prod = id => state.catalog.products.find(p => p.id === id);
const cartLines = () => state.cart.map(i => ({ ...i, p: prod(i.product_id) })).filter(l => l.p);
const subtotal = () => cartLines().reduce((a, l) => a + l.p.effective_cents * l.qty, 0);

function feeFor(nb) {
  const n = (nb || "").trim().toLowerCase();
  const z = state.catalog.zones.find(z => z.name.toLowerCase() === n);
  let fee = z ? z.fee_cents : state.catalog.default_fee_cents;
  const free = state.catalog.free_shipping_cents;
  if (free && subtotal() >= free) fee = 0;
  return fee;
}

/* ---------- rotas ---------- */
const routes = { "": home, produtos, sacola, checkout, compras, conta, entrar, admin };
async function router() {
  const r = (location.hash.replace(/^#\/?/, "").split("?")[0]) || "";
  $("#nav").classList.remove("open"); $("#burger").setAttribute("aria-expanded", "false");
  document.querySelectorAll("nav a").forEach(a => a.classList.toggle("on", a.dataset.r === (r || "home") || (r === "checkout" && a.dataset.r === "sacola")));
  try { await (routes[r] || home)(); } catch (e) { if (e.code === 401) { state.user = null; renderNav(); location.hash = "#/entrar"; } else app.innerHTML = `<div class="wrap"><div class="err">${esc(e.message)}</div></div>`; }
  window.scrollTo({ top: 0 });
}
function renderNav() {
  const u = state.user;
  $("#authLink").textContent = u ? "Sair" : "Login / Cadastro";
  $("#authLink").href = u ? "#/sair" : "#/entrar";
  $("#adminLink").hidden = !(u && u.is_admin);
}
async function loadCatalog() { state.catalog = await api("catalog"); }
const view = html => { app.innerHTML = `<div class="view">${html}</div>`; };

/* ---------- produtos ---------- */
const qtyState = {};
function productCard(p) {
  const q = qtyState[p.id] || 1;
  const promo = p.promo_price_cents && p.promo_price_cents < p.price_cents;
  const per = (p.effective_cents / p.eggs / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const low = p.stock > 0 && p.stock <= 10;
  return `<article class="card" data-id="${p.id}">
    <div class="ph"><img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">${promo ? `<span class="tag">OFERTA</span>` : ""}</div>
    <div class="bd"><h3>${esc(p.name)}</h3><div class="stock ${low ? "low" : ""}">${KIND[p.kind]}${p.stock <= 0 ? " · Esgotado" : low ? ` · Restam ${p.stock}` : ""}</div>
    <p>${esc(p.description)}</p>
    <div class="price">${money(p.effective_cents)}${promo ? `<s>${money(p.price_cents)}</s>` : ""}<small>${per} por ovo</small></div>
    <div class="buy"><div class="qty"><button data-d="-1" aria-label="Diminuir">−</button><span>${q}</span><button data-d="1" aria-label="Aumentar">+</button></div>
    <button class="btn green add" ${p.stock <= 0 ? "disabled" : ""}>Adicionar</button></div></div></article>`;
}
function bindCards() {
  app.querySelectorAll(".card").forEach(c => {
    const id = +c.dataset.id, p = prod(id);
    c.querySelectorAll(".qty button").forEach(b => b.onclick = () => { const n = Math.min(Math.max(1, (qtyState[id] || 1) + +b.dataset.d), Math.max(1, p.stock)); qtyState[id] = n; c.querySelector(".qty span").textContent = n; });
    c.querySelector(".add").onclick = () => {
      const q = qtyState[id] || 1, ex = state.cart.find(i => i.product_id === id), have = ex ? ex.qty : 0;
      if (have + q > p.stock) return toast(`Só temos ${p.stock} em estoque.`, true);
      if (ex) ex.qty += q; else state.cart.push({ product_id: id, qty: q });
      saveCart(); toast(`${q}× ${p.name} na sacola 🥚`); qtyState[id] = 1; c.querySelector(".qty span").textContent = 1;
    };
  });
}
async function home() {
  await loadCatalog();
  const promos = state.catalog.products.filter(p => p.promo_price_cents && p.promo_price_cents < p.price_cents);
  const free = state.catalog.free_shipping_cents;
  app.innerHTML = `<div class="view">
  <section class="hero"><div class="hero-in"><div>
    <h1>Ovos frescos,<br><em>protegidos</em> em cada detalhe.</h1>
    <p>Compre por unidade, dúzia ou cartela com 20 ovos e receba na sua porta. Acompanhe cada etapa da entrega.</p>
    <a class="btn" href="#/produtos">Ver produtos →</a></div>
    <img src="/img/logo.png" alt="Logo The Egg"></div></section>
  <div class="perks"><div class="perk"><span>🚚</span>Entrega em domicílio</div><div class="perk"><span>📦</span>Embalagem protetora</div><div class="perk"><span>📍</span>Acompanhe seu pedido</div><div class="perk"><span>🔒</span>Compra segura</div></div>
  <div class="wrap">
    ${promos.length || free ? `<div class="promo"><div><span class="tag">PROMOÇÕES</span> <b>${promos.length ? "Ofertas especiais no ar!" : ""}</b> ${free ? `Frete grátis em compras a partir de <b>${money(free)}</b>.` : ""}</div><a class="btn sm" href="#/produtos">Aproveitar</a></div>` : ""}
    <h2>Nossos produtos</h2><div class="grid">${state.catalog.products.map(productCard).join("")}</div>
  </div></div>`;
  bindCards();
}
async function produtos() {
  await loadCatalog();
  view(`<div class="wrap"><h2>Produtos</h2><div class="grid">${state.catalog.products.map(productCard).join("")}</div></div>`);
  bindCards();
}

/* ---------- sacola ---------- */
async function sacola() {
  await loadCatalog();
  state.cart = state.cart.filter(i => prod(i.product_id)); saveCart();
  const lines = cartLines();
  if (!lines.length) return view(`<div class="wrap"><h2>Minha Sacola</h2><div class="box empty"><div class="big">🧺</div><h3>Sua sacola está vazia</h3><p style="margin:8px 0 18px">Que tal escolher uns ovos fresquinhos?</p><a class="btn" href="#/produtos">Ver produtos</a></div></div>`);
  const sub = subtotal(), fee = state.catalog.default_fee_cents;
  view(`<div class="wrap"><h2>Minha Sacola</h2><div class="cols">
  <div class="box">${lines.map(l => `<div class="item" data-id="${l.p.id}">
    <img src="${esc(l.p.image)}" alt=""><div><h3>${esc(l.p.name)}</h3><div class="meta">${KIND[l.p.kind]} · ${money(l.p.effective_cents)} cada</div></div>
    <div class="right"><div class="qty"><button data-d="-1" aria-label="Diminuir">−</button><span>${l.qty}</span><button data-d="1" aria-label="Aumentar">+</button></div>
    <b>${money(l.p.effective_cents * l.qty)}</b><button class="rm">Remover</button></div></div>`).join("")}</div>
  <aside class="box"><h3>Resumo do pedido</h3>
    <div class="sum"><span>Subtotal</span><span>${money(sub)}</span></div>
    <div class="sum"><span>Taxa de entrega</span><span>a partir de ${money(Math.min(fee, ...state.catalog.zones.map(z => z.fee_cents)))}</span></div>
    <div class="sum total"><span>Total</span><span>${money(sub)}+</span></div>
    <p style="font-size:.82rem;color:var(--mute);margin:6px 0 14px">A taxa exata depende do seu bairro e aparece no checkout antes de confirmar.</p>
    <a class="btn green big" href="#/checkout">Finalizar Compra</a></aside></div></div>`);
  app.querySelectorAll(".item").forEach(el => {
    const id = +el.dataset.id, it = state.cart.find(i => i.product_id === id), p = prod(id);
    el.querySelectorAll(".qty button").forEach(b => b.onclick = () => {
      const n = it.qty + +b.dataset.d;
      if (n < 1) return; if (n > p.stock) return toast(`Só temos ${p.stock} em estoque.`, true);
      it.qty = n; saveCart(); sacola();
    });
    el.querySelector(".rm").onclick = () => { state.cart = state.cart.filter(i => i.product_id !== id); saveCart(); sacola(); };
  });
}

/* ---------- checkout ---------- */
async function checkout() {
  await loadCatalog();
  if (!state.user) { toast("Entre na sua conta para finalizar a compra."); sessionStorage.setItem("egg_after", "#/checkout"); return location.hash = "#/entrar"; }
  const lines = cartLines();
  if (!lines.length) return location.hash = "#/sacola";
  const u = state.user, sub = subtotal();
  view(`<div class="wrap"><h2>Finalizar compra</h2><div class="cols">
  <form class="box form" id="f" novalidate>
    <h3>Dados de entrega</h3><div id="msg"></div>
    <label><span class="req">Nome completo</span><input name="name" value="${esc(u.name)}" required autocomplete="name"></label>
    <label><span class="req">Telefone</span><input name="phone" value="${esc(u.phone)}" required inputmode="tel" autocomplete="tel" placeholder="(00) 00000-0000"></label>
    <div class="row2"><label><span class="req">Endereço (rua/avenida)</span><input name="street" required autocomplete="address-line1"></label>
    <label><span class="req">Número</span><input name="number" required></label></div>
    <div class="row2"><label><span class="req">Bairro / região</span><input name="neighborhood" list="nbs" required autocomplete="off"><datalist id="nbs">${state.catalog.zones.map(z => `<option value="${esc(z.name)}">`).join("")}</datalist></label>
    <label>Complemento<input name="complement" placeholder="Apto, bloco, referência…"></label></div>
    <label><span class="req">Forma de pagamento</span><select name="payment" required><option value="">Selecione…</option>${state.catalog.payments.map(p => `<option>${esc(p)}</option>`).join("")}</select></label>
  </form>
  <aside class="box"><h3>Resumo</h3>
    ${lines.map(l => `<div class="sum"><span>${l.qty}× ${esc(l.p.name)}</span><span>${money(l.p.effective_cents * l.qty)}</span></div>`).join("")}
    <div class="sum"><span>Subtotal</span><span>${money(sub)}</span></div>
    <div class="sum"><span>Taxa de entrega</span><span id="fee">informe o bairro</span></div>
    <div class="sum total"><span>Total</span><span id="tot">${money(sub)}</span></div>
    <button class="btn green big" id="go" style="margin-top:14px">Confirmar pedido</button></aside></div></div>`);
  const f = $("#f");
  const upd = () => {
    const nb = f.neighborhood.value.trim();
    if (!nb) { $("#fee").textContent = "informe o bairro"; $("#tot").textContent = money(sub); return; }
    const fee = feeFor(nb); $("#fee").textContent = fee ? money(fee) : "Grátis"; $("#tot").textContent = money(sub + fee);
  };
  f.neighborhood.addEventListener("input", upd);
  $("#go").onclick = async () => {
    const d = Object.fromEntries(new FormData(f)); const m = $("#msg"); m.innerHTML = "";
    f.querySelectorAll("[required]").forEach(i => i.style.borderColor = i.value.trim() ? "" : "var(--red)");
    const miss = [...f.querySelectorAll("[required]")].find(i => !i.value.trim());
    if (miss) { m.innerHTML = `<div class="err">Preencha todos os campos obrigatórios (*).</div>`; miss.focus(); return; }
    $("#go").disabled = true;
    try {
      const r = await api("orders", "POST", { ...d, items: state.cart });
      state.cart = []; saveCart(); toast("Pedido realizado! 🎉"); location.hash = "#/compras?novo=" + r.order.id;
    } catch (e) { m.innerHTML = `<div class="err">${esc(e.message)}</div>`; $("#go").disabled = false; if (e.code === 409) await loadCatalog(); }
  };
}

/* ---------- compras ---------- */
function timeline(o, flow) {
  const cur = flow.findIndex(s => s[0] === o.status);
  return `<div class="tl" aria-label="Linha do tempo do pedido">${flow.map((s, i) => `<div class="st ${i < cur ? "done" : i === cur ? "cur" : ""}"><div class="dot">${i < cur ? "✓" : i + 1}</div><div>${s[1]}</div></div>`).join("")}</div>`;
}
function orderCard(o, flow) {
  const label = (flow.find(s => s[0] === o.status) || [, o.status])[1];
  return `<article class="box order" id="o${o.id}"><div class="oh"><h3>Pedido #${String(o.id).padStart(5, "0")}</h3><span class="badge ${o.status}">${esc(label)}</span></div>
  <div style="color:var(--mute);font-size:.88rem">Realizado em ${fmtDate(o.created)}</div>
  ${timeline(o, flow)}
  <div class="facts"><div><b>Status atual</b>${esc(label)}</div><div><b>Última atualização</b>${fmtDate(o.status_updated)}</div><div><b>Taxa de envio cobrada</b>${o.fee_cents ? money(o.fee_cents) : "Grátis"}</div>
  <div><b>Endereço de destino</b>${esc(o.street)}, ${esc(o.number)}${o.complement ? " — " + esc(o.complement) : ""} · ${esc(o.neighborhood)}</div></div>
  <div class="tw" style="margin-top:14px"><table><thead><tr><th>Produto</th><th>Embalagem</th><th>Qtd.</th><th>Ovos</th><th>Valor</th></tr></thead><tbody>
  ${o.items.map(i => `<tr><td>${esc(i.name)}</td><td>${KIND[i.kind] || i.kind}</td><td>${i.qty}</td><td>${i.eggs * i.qty}</td><td>${money(i.unit_cents * i.qty)}</td></tr>`).join("")}</tbody></table></div>
  <div class="facts" style="background:#fff;border:1px solid var(--line)"><div><b>Produtos</b>${money(o.subtotal_cents)}</div><div><b>Entrega</b>${money(o.fee_cents)}</div><div><b>Total (${o.eggs_total} ovos)</b><span style="font-size:1.2rem;font-weight:800">${money(o.total_cents)}</span></div><div><b>Pagamento</b>${esc(o.payment)}</div></div></article>`;
}
async function compras() {
  if (!state.user) { sessionStorage.setItem("egg_after", "#/compras"); toast("Entre para ver suas compras."); return location.hash = "#/entrar"; }
  const { orders, flow } = await api("orders");
  const novo = new URLSearchParams(location.hash.split("?")[1] || "").get("novo");
  view(`<div class="wrap"><h2>Minhas Compras</h2>${novo ? `<div class="ok" style="margin-bottom:16px">✅ Pedido #${String(novo).padStart(5, "0")} recebido! Acompanhe abaixo cada etapa.</div>` : ""}
  ${orders.length ? orders.map(o => orderCard(o, flow)).join("") : `<div class="box empty"><div class="big">📦</div><h3>Você ainda não fez compras</h3><p style="margin:8px 0 18px">Seus pedidos aparecerão aqui.</p><a class="btn" href="#/produtos">Começar a comprar</a></div>`}</div>`);
  if (novo) $("#o" + novo)?.scrollIntoView({ behavior: "smooth" });
}

/* ---------- conta / login ---------- */
async function entrar() {
  if (state.user) return location.hash = "#/conta";
  let mode = "login";
  const draw = (msg = "", ok = false) => {
    view(`<div class="wrap"><div class="box auth"><img class="logo" src="/img/logo.png" alt="The Egg">
    <div class="tabs"><button data-m="login" class="${mode === "login" ? "on" : ""}">Entrar</button><button data-m="reg" class="${mode === "reg" ? "on" : ""}">Criar conta</button></div>
    ${msg ? `<div class="${ok ? "ok" : "err"}" style="margin-bottom:12px">${esc(msg)}</div>` : ""}
    <form class="form" id="af" novalidate>
      ${mode === "reg" ? `<label>Nome completo<input name="name" required autocomplete="name"></label><label>Telefone<input name="phone" inputmode="tel" autocomplete="tel"></label>` : ""}
      ${mode === "forgot" || mode === "reset" ? "" : ""}
      <label>E-mail<input name="email" type="email" required autocomplete="email"></label>
      ${mode === "forgot" ? "" : mode === "reset" ? `<label>Código recebido<input name="token" required></label><label>Nova senha<input name="password" type="password" minlength="6" required></label>` : `<label>Senha<input name="password" type="password" minlength="6" required autocomplete="${mode === "reg" ? "new-password" : "current-password"}"></label>`}
      <button class="btn green big">${{ login: "Entrar", reg: "Criar minha conta", forgot: "Enviar instruções", reset: "Redefinir senha" }[mode]}</button>
      ${mode === "login" ? `<button type="button" class="linkbtn" data-m="forgot">Esqueci minha senha</button>` : `<button type="button" class="linkbtn" data-m="login">Voltar ao login</button>`}
    </form></div></div>`);
    app.querySelectorAll("[data-m]").forEach(b => b.onclick = () => { mode = b.dataset.m; draw(); });
    $("#af").onsubmit = async ev => {
      ev.preventDefault(); const d = Object.fromEntries(new FormData(ev.target));
      try {
        if (mode === "forgot") { const r = await api("forgot", "POST", d); mode = "reset"; return draw(r.message + " Informe o código e a nova senha.", true); }
        if (mode === "reset") { await api("reset", "POST", d); mode = "login"; return draw("Senha redefinida! Faça login.", true); }
        const r = await api(mode === "reg" ? "register" : "login", "POST", d);
        state.user = r.user; renderNav(); toast(`Bem-vindo(a), ${r.user.name.split(" ")[0]}!`);
        const after = sessionStorage.getItem("egg_after"); sessionStorage.removeItem("egg_after");
        location.hash = after || (r.user.is_admin ? "#/admin" : "#/");
      } catch (e) { draw(e.message); }
    };
  };
  draw();
}
async function sair() { await api("logout", "POST"); state.user = null; renderNav(); toast("Você saiu da conta."); location.hash = "#/"; }
routes.sair = sair;
async function conta() {
  if (!state.user) { sessionStorage.setItem("egg_after", "#/conta"); return location.hash = "#/entrar"; }
  const u = state.user, { orders } = await api("orders");
  view(`<div class="wrap"><h2>Minha Conta</h2><div class="cols"><form class="box form" id="cf"><h3>Meus dados</h3><div id="cm"></div>
  <label>Nome<input name="name" value="${esc(u.name)}" required></label><label>E-mail<input value="${esc(u.email)}" disabled></label>
  <label>Telefone<input name="phone" value="${esc(u.phone)}"></label>
  <h3 style="margin-top:8px">Alterar senha <small style="font-weight:400;color:var(--mute)">(opcional)</small></h3>
  <div class="row2"><label>Senha atual<input name="current_password" type="password" autocomplete="current-password"></label><label>Nova senha<input name="new_password" type="password" minlength="6" autocomplete="new-password"></label></div>
  <button class="btn green">Salvar alterações</button></form>
  <aside class="box"><h3>Histórico de compras</h3><div class="sum"><span>Pedidos</span><span>${orders.length}</span></div><div class="sum"><span>Total gasto</span><span>${money(orders.reduce((a, o) => a + o.total_cents, 0))}</span></div>
  <a class="btn ghost" style="margin-top:10px;width:100%" href="#/compras">Ver minhas compras</a>
  <button class="btn danger" style="margin-top:10px;width:100%" id="lo">Sair da conta</button></aside></div></div>`);
  $("#lo").onclick = sair;
  $("#cf").onsubmit = async ev => {
    ev.preventDefault(); const d = Object.fromEntries(new FormData(ev.target));
    try { const r = await api("account", "PUT", d); state.user = r.user; $("#cm").innerHTML = `<div class="ok">Dados atualizados.</div>`; ev.target.current_password.value = ev.target.new_password.value = ""; }
    catch (e) { $("#cm").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

/* ---------- admin ---------- */
let atab = "painel";
async function admin() {
  if (!state.user) { sessionStorage.setItem("egg_after", "#/admin"); return location.hash = "#/entrar"; }
  if (!state.user.is_admin) return view(`<div class="wrap"><div class="err">Acesso restrito ao administrador.</div></div>`);
  const tabs = [["painel", "📊 Painel"], ["pedidos", "🧾 Pedidos"], ["produtos", "🥚 Produtos & estoque"], ["taxas", "🚚 Taxas de envio"], ["clientes", "👥 Clientes"]];
  view(`<div class="wrap"><h2>Painel administrativo</h2><div class="atabs">${tabs.map(t => `<button data-t="${t[0]}" class="${atab === t[0] ? "on" : ""}">${t[1]}</button>`).join("")}</div><div id="ab"></div></div>`);
  app.querySelectorAll(".atabs button").forEach(b => b.onclick = () => { atab = b.dataset.t; admin(); });
  ({ painel: aPainel, pedidos: aPedidos, produtos: aProdutos, taxas: aTaxas, clientes: aClientes })[atab]($("#ab"));
}
async function aPainel(el) {
  const s = await api("admin/stats"), names = { realizado: "Realizado", pago: "Pago", preparo: "Em preparo", entrega: "Em entrega", entregue: "Entregue" };
  const max = Math.max(1, ...s.days.map(d => d.total || 0));
  el.innerHTML = `<div class="stats"><div class="stat"><small>Faturamento total</small><div>${money(s.revenue_cents)}</div></div><div class="stat"><small>Vendas de produtos</small><div>${money(s.products_cents)}</div></div><div class="stat"><small>Taxas de entrega</small><div>${money(s.fees_cents)}</div></div><div class="stat"><small>Pedidos</small><div>${s.orders}</div></div><div class="stat"><small>Ovos vendidos</small><div>${s.eggs}</div></div><div class="stat"><small>Clientes</small><div>${s.customers}</div></div></div>
  <div class="cols"><div class="box"><h3>Vendas por dia (últimos 14 dias)</h3><div class="bars" style="margin-top:12px">${s.days.length ? s.days.map(d => `<div class="bar"><span>${d.day.split("-").reverse().slice(0, 2).join("/")}</span><i style="width:${Math.max(4, d.total / max * 100)}%"></i><b>${money(d.total)}</b></div>`).join("") : "<p class='stock'>Nenhuma venda ainda.</p>"}</div></div>
  <div class="box"><h3>Pedidos por status</h3><div style="margin-top:10px">${s.by_status.map(b => `<div class="sum"><span>${names[b.status] || b.status}</span><b>${b.n}</b></div>`).join("") || "<p class='stock'>Sem pedidos.</p>"}</div></div></div>`;
}
async function aPedidos(el) {
  const { orders, flow } = await api("admin/orders");
  if (!orders.length) return el.innerHTML = `<div class="box empty">Nenhum pedido recebido ainda.</div>`;
  el.innerHTML = orders.map(o => `<article class="box order"><div class="oh"><h3>Pedido #${String(o.id).padStart(5, "0")} — ${esc(o.name)}</h3>
  <select data-id="${o.id}" style="width:auto">${flow.map(s => `<option value="${s[0]}" ${s[0] === o.status ? "selected" : ""}>${s[1]}</option>`).join("")}</select></div>
  ${timeline(o, flow)}
  <div class="facts"><div><b>Cliente</b>${esc(o.name)}<br>${esc(o.phone)}<br>${esc(o.email)}</div><div><b>Entrega</b>${esc(o.street)}, ${esc(o.number)}${o.complement ? " — " + esc(o.complement) : ""}<br>${esc(o.neighborhood)}</div><div><b>Pagamento</b>${esc(o.payment)}</div><div><b>Taxa cobrada</b>${money(o.fee_cents)}</div><div><b>Total</b>${money(o.total_cents)}</div><div><b>Atualizado</b>${fmtDate(o.status_updated)}</div></div>
  <div style="margin-top:10px;font-size:.9rem">${o.items.map(i => `${i.qty}× ${esc(i.name)} (${i.eggs * i.qty} ovos)`).join(" · ")}</div></article>`).join("");
  el.querySelectorAll("select[data-id]").forEach(s => s.onchange = async () => { try { await api("admin/orders/" + s.dataset.id, "PUT", { status: s.value }); toast("Status atualizado ✔"); aPedidos(el); } catch (e) { toast(e.message, true); } });
}
async function aProdutos(el) {
  const { products } = await api("admin/products");
  el.innerHTML = `<div class="box tw"><table><thead><tr><th></th><th>Produto</th><th>Formato</th><th>Preço</th><th>Promo</th><th>Estoque</th><th>Ativo</th><th></th></tr></thead><tbody>
  ${products.map(p => `<tr><td><img class="thumb" src="${esc(p.image)}" alt=""></td><td>${esc(p.name)}</td><td>${KIND[p.kind]}</td><td>${money(p.price_cents)}</td><td>${p.promo_price_cents ? money(p.promo_price_cents) : "—"}</td><td>${p.stock}</td><td>${p.active ? "Sim" : "Não"}</td>
  <td style="white-space:nowrap"><button class="btn sm ghost" data-e="${p.id}">Editar</button> <button class="btn sm danger" data-x="${p.id}">Desativar</button></td></tr>`).join("")}</tbody></table></div>
  <form class="box form" id="pf" style="margin-top:20px"><h3 id="pt">Novo produto</h3><div id="pm"></div><input type="hidden" name="id">
  <div class="row2"><label>Nome<input name="name" required></label><label>Formato<select name="kind"><option value="unidade">Unidade (1 ovo)</option><option value="duzia">Dúzia (12 ovos)</option><option value="vinte">20 ovos</option></select></label></div>
  <div class="row2"><label>Preço (R$)<input name="price" type="number" step="0.01" min="0.01" required></label><label>Preço promocional (R$, opcional)<input name="promo_price" type="number" step="0.01" min="0"></label></div>
  <div class="row2"><label>Estoque (unidades à venda)<input name="stock" type="number" min="0" value="0" required></label><label>Imagem (PNG/JPG/WebP até 4 MB)<input name="file" type="file" accept="image/png,image/jpeg,image/webp"></label></div>
  <label>Descrição<textarea name="description" rows="2"></textarea></label>
  <label style="display:flex;gap:8px;align-items:center;grid-auto-flow:column;justify-content:start"><input type="checkbox" name="active" checked style="width:auto"> Ativo na loja</label>
  <div style="display:flex;gap:10px"><button class="btn green">Salvar produto</button><button type="button" class="btn ghost" id="pn">Limpar</button></div></form>`;
  const f = $("#pf");
  el.querySelectorAll("[data-e]").forEach(b => b.onclick = () => { const p = products.find(x => x.id == b.dataset.e); f.id.value = p.id; f.name.value = p.name; f.kind.value = p.kind; f.price.value = p.price_cents / 100; f.promo_price.value = p.promo_price_cents ? p.promo_price_cents / 100 : ""; f.stock.value = p.stock; f.description.value = p.description; f.active.checked = !!p.active; $("#pt").textContent = "Editar: " + p.name; f.scrollIntoView({ behavior: "smooth" }); });
  el.querySelectorAll("[data-x]").forEach(b => b.onclick = async () => { if (confirm("Desativar este produto? O histórico de pedidos é mantido.")) { await api("admin/products/" + b.dataset.x, "DELETE"); aProdutos(el); } });
  $("#pn").onclick = () => aProdutos(el);
  f.onsubmit = async ev => {
    ev.preventDefault(); const fd = new FormData(f); let image = "";
    const file = f.file.files[0];
    if (file) image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
    const body = { name: fd.get("name"), kind: fd.get("kind"), price: fd.get("price"), promo_price: fd.get("promo_price"), stock: fd.get("stock"), description: fd.get("description"), active: f.active.checked, image };
    try { const id = fd.get("id"); await api("admin/products" + (id ? "/" + id : ""), id ? "PUT" : "POST", body); toast("Produto salvo ✔"); aProdutos(el); }
    catch (e) { $("#pm").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}
async function aTaxas(el) {
  const z = await api("admin/zones");
  el.innerHTML = `<div class="cols"><div class="box"><h3>Taxa por bairro / região</h3><table><thead><tr><th>Bairro/Região</th><th>Taxa</th><th></th></tr></thead><tbody>
  ${z.zones.map(x => `<tr><td>${esc(x.name)}</td><td>${money(x.fee_cents)}</td><td><button class="btn sm ghost" data-ed="${x.id}">Editar</button> <button class="btn sm danger" data-rm="${x.id}">Excluir</button></td></tr>`).join("") || "<tr><td colspan=3>Nenhuma região cadastrada.</td></tr>"}</tbody></table>
  <form class="form" id="zf" style="margin-top:16px"><div class="row2"><label>Bairro / região<input name="name" required></label><label>Taxa (R$)<input name="fee" type="number" step="0.01" min="0" required></label></div><button class="btn green">Adicionar / atualizar</button></form></div>
  <form class="box form" id="df"><h3>Regras gerais</h3><div id="dm"></div><label>Taxa padrão (bairros não listados) — R$<input name="default_fee" type="number" step="0.01" min="0" value="${z.default_fee_cents / 100}" required></label>
  <label>Frete grátis a partir de (R$, 0 = desativado)<input name="free_shipping" type="number" step="0.01" min="0" value="${z.free_shipping_cents / 100}"></label><button class="btn green">Salvar regras</button></form></div>`;
  el.querySelectorAll("[data-ed]").forEach(b => b.onclick = () => { const x = z.zones.find(q => q.id == b.dataset.ed); $("#zf").name.value = x.name; $("#zf").fee.value = x.fee_cents / 100; $("#zf").fee.focus(); });
  el.querySelectorAll("[data-rm]").forEach(b => b.onclick = async () => { await api("admin/zones/" + b.dataset.rm, "DELETE"); aTaxas(el); });
  $("#zf").onsubmit = async ev => { ev.preventDefault(); try { await api("admin/zones", "POST", Object.fromEntries(new FormData(ev.target))); toast("Taxa salva ✔"); aTaxas(el); } catch (e) { toast(e.message, true); } };
  $("#df").onsubmit = async ev => { ev.preventDefault(); try { await api("admin/zones", "PUT", Object.fromEntries(new FormData(ev.target))); toast("Regras salvas ✔"); } catch (e) { toast(e.message, true); } };
}
async function aClientes(el) {
  const { customers } = await api("admin/customers");
  el.innerHTML = `<div class="box tw"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Cadastro</th><th>Pedidos</th><th>Total gasto</th></tr></thead><tbody>
  ${customers.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td><td>${fmtDate(c.created)}</td><td>${c.orders}</td><td>${money(c.spent)}</td></tr>`).join("") || "<tr><td colspan=6>Nenhum cliente ainda.</td></tr>"}</tbody></table></div>`;
}

/* ---------- boot ---------- */
$("#burger").onclick = () => { const n = $("#nav"); const o = n.classList.toggle("open"); $("#burger").setAttribute("aria-expanded", o); };
$("#yr").textContent = new Date().getFullYear();
window.addEventListener("hashchange", router);
(async () => {
  try { state.user = (await api("me")).user; } catch { }
  renderNav(); updateBadge(); router();
})();
