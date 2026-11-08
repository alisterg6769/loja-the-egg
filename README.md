# The Egg — loja virtual de ovos

Servidor Python puro (sem instalar nada) + banco SQLite + site responsivo.

## Como rodar
    python3 server.py
Abra http://localhost:8000

## Acesso do administrador (troque a senha em "Minha Conta")
- E-mail: admin@theegg.com
- Senha: admin123
Após entrar, aparece o menu **Admin** (painel, pedidos, produtos/estoque, taxas, clientes).

## Observações
- Dados ficam em `theegg.db` (permanente). Faça backup desse arquivo.
- Imagens de produtos enviadas pelo admin vão para `static/uploads/`.
- Recuperação de senha: não há serviço de e-mail configurado; o código aparece no
  console do servidor. Para produção, integre um provedor de e-mail em `/api/forgot`.
- Pagamento: o site registra a forma escolhida (Pix, dinheiro, cartão na entrega);
  o admin confirma o pagamento mudando o status do pedido. Não há gateway online.
- Para publicar na internet use HTTPS (proxy como Caddy/Nginx) e rode com `PORT=80`/atrás do proxy.
