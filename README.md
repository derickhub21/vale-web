# VALE? — projeto web (fora do sandbox do Claude Artifact)

Este é o VALE? empacotado como um projeto React + Vite normal, pronto para
rodar em qualquer hospedagem estática. É exatamente o mesmo app (mesmo
design, mesmo fluxo, mesma integração com o Supabase) — a única mudança em
relação à versão que rodava no Artifact do Claude foi trocar `window.storage`
(que só existe lá dentro) por `localStorage` (padrão de qualquer navegador),
porque era isso que impedia o cadastro de funcionar (a CSP do sandbox
bloqueava as chamadas para `supabase.co`). Fora do Artifact essa restrição
não existe.

## Arquivos deste projeto

```
vale-web/
├── index.html          ← HTML raiz, carrega src/main.jsx
├── package.json        ← dependências (react, react-dom, vite)
├── package-lock.json    ← trava as versões exatas (bom para builds reprodutíveis)
├── vite.config.js       ← configuração mínima do Vite (só o plugin do React)
├── .gitignore
└── src/
    ├── main.jsx          ← ponto de entrada, renderiza <App />
    └── App.jsx           ← o VALE? em si (idêntico ao artifact, com a troca
                             de window.storage → localStorage)
```

Não existe nenhuma outra dependência exclusiva do Claude — já auditei o
arquivo inteiro: fora o `localStorage`, só são usadas APIs padrão de
navegador (`fetch`, `window.open`, `navigator.share`, `navigator.clipboard`)
e a própria biblioteca `react`. **Já rodei `npm install` + `npm run build`
aqui para confirmar que o projeto builda sem erros** antes de te entregar.

## Rodar localmente (opcional, antes de publicar)

```bash
npm install
npm run dev
```
Abre em `http://localhost:5173`.

## Publicar em uma URL pública — caminho mais simples: Vercel

1. Crie um repositório no GitHub (pode ser privado) e suba esta pasta nele:
   ```bash
   git init
   git add .
   git commit -m "VALE? - primeira versão web"
   git branch -M main
   git remote add origin <url-do-seu-repo-no-github>
   git push -u origin main
   ```
2. Entre em [vercel.com](https://vercel.com), faça login com sua conta
   GitHub e clique em **"Add New… → Project"**.
3. Selecione o repositório do VALE?. A Vercel detecta sozinha que é um
   projeto Vite (framework preset "Vite") — não precisa mudar nenhuma
   configuração de build ou output.
4. Não é preciso configurar nenhuma variável de ambiente: a URL do Supabase
   e a chave pública (`anon key`) já estão no código (`ACCESS_CONFIG`/
   `SUPABASE_CONFIG` dentro de `src/App.jsx`), exatamente como estavam no
   Artifact — não mexi nisso.
5. Clique em **Deploy**. Em ~1 minuto você tem uma URL pública tipo
   `https://vale-app-xxxx.vercel.app`.

**Alternativa sem Git**, se preferir o caminho mais rápido possível:
```bash
npm run build
```
Isso gera a pasta `dist/`. Vá em [app.netlify.com/drop](https://app.netlify.com/drop)
e arraste a pasta `dist` — a Netlify publica na hora e te dá uma URL pública.
(Funciona igual na própria Vercel via `vercel --prod` com a CLI deles, se
preferir.)

## Sobre CORS/CSP no Supabase

Não é preciso configurar nada no Supabase para isso funcionar. As chamadas
que o app faz (`/auth/v1/signup`, `/auth/v1/token`, `/rest/v1/profiles`,
`/rest/v1/rpc/increment_used_analyses`) usam a `anon key` pública, e o
Supabase já responde com CORS liberado por padrão para esse tipo de chamada
— não há necessidade de cadastrar a URL da Vercel/Netlify em nenhuma lista
de origens permitidas.

## O que ainda não está implementado (por decisão, não por esquecimento)

- Webhook da Cakto (confirmação real de pagamento) — combinamos deixar para
  depois de validar cadastro/login/perfil em produção.
- Nenhuma mudança foi feita no banco, RLS, migrations, triggers ou na função
  `increment_used_analyses()` — está tudo exatamente como testamos antes.
