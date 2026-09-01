import React, { useState, useMemo, useRef, useEffect } from "react";

/* =========================================================================
   VALE? — MVP
   "Antes de comprar, descubra se vale a pena."

   ARQUITETURA DE DADOS (leia antes de integrar uma API real)
   -------------------------------------------------------------------------
   Este MVP usa a função `mockAnalyze()` abaixo para SIMULAR uma análise de
   preço. Ela gera um "preço de referência" de forma determinística a partir
   dos dados digitados (marca + modelo + ano), apenas para demonstrar o
   fluxo e o layout da tela de resultado. NENHUM dado real de mercado é
   usado — isso fica bem sinalizado na interface ("REFERÊNCIA SIMULADA").

   Indicadores de Manutenção e Revenda mostram "Dados insuficientes" porque
   ainda não existe uma fonte real para essas informações — nunca inventamos
   uma avaliação como se fosse dado real.

   Quando uma API automotiva / tabela FIPE for integrada, o caminho é:

   1. O frontend envia { brand, model, year, km, price } para uma rota
      própria de backend (ex: Edge Function), nunca direto para a API
      externa.
   2. O backend guarda a API key como variável de ambiente, consulta a API
      automotiva e calcula o preço de referência de verdade (e, quando
      disponíveis, dados reais de manutenção/revenda).
   3. O backend responde com um payload no mesmo formato que `mockAnalyze`
      já devolve hoje (ver `AnalysisResult` abaixo). Assim, basta trocar:

          const result = mockAnalyze(form);

      por uma chamada assíncrona ao backend:

          const result = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(form),
          }).then(r => r.json());

   A API key NUNCA deve ser adicionada ao código do frontend.

   AnalysisResult = {
     score: number (0-10),
     verdictTone: 'good' | 'warn' | 'bad',
     verdictLabel: string,
     referencePrice: number,
     diffPct: number,
     verdictText: string,
     indicators: [{ key, label, value, tone }],
     isSimulated: boolean
   }

   ARQUITETURA DE ACESSO / MONETIZAÇÃO (leia antes de mexer em auth/paywall)
   -------------------------------------------------------------------------
   O acesso é por QUANTIDADE DE ANÁLISES, não por tempo. Todo usuário logado
   ganha ACCESS_CONFIG.FREE_ANALYSES_LIMIT análises gratuitas; cada uma só é
   contabilizada quando o resultado é efetivamente gerado (ver
   `completeAnalysis()`).

   FONTE REAL DE VERDADE: o projeto Supabase "VALE" (SUPABASE_CONFIG.URL).
   -------------------------------------------------------------------------
   - Autenticação por e-mail/senha via o próprio Supabase Auth (API REST,
     sem SDK — ver `supaSignUp` / `supaSignIn` / `supaRefreshSession`).
   - Tabela `public.profiles` (1 linha por usuário, criada automaticamente
     por um trigger em `auth.users`): id, email, used_analyses, is_premium,
     created_at, updated_at.
   - RLS: o usuário só consegue LER a própria linha. NÃO existe policy de
     UPDATE/INSERT/DELETE para o cliente — ou seja, is_premium e
     used_analyses são IMPOSSÍVEIS de alterar diretamente pelo frontend,
     mesmo abrindo o DevTools e chamando a API na mão. A única escrita
     permitida ao usuário logado é a função `increment_used_analyses()`
     (RPC, SECURITY DEFINER), que só incrementa a própria linha e nunca
     mexe em is_premium.
   - `computeAccess(profile)` deriva o status a partir da linha vinda do
     Supabase — nunca um contador visual "fake":

       FREE_ANALYSES_REMAINING  -> used_analyses < ACCESS_CONFIG.FREE_ANALYSES_LIMIT
       USED_ANALYSES            -> as gratuitas acabaram e is_premium é falso
       PREMIUM                  -> is_premium é verdadeiro

   `canStartAnalysis()` é a única função que decide se uma nova análise pode
   começar (usada tanto na Home quanto em "Nova análise"). `completeAnalysis()`
   é a única função que consome 1 análise gratuita (chamando o RPC acima), e
   só deve ser chamada depois que a tela de resultado é alcançada de
   verdade — se o usuário voltar, recarregar ou sair antes disso, nada é
   descontado.

   `localStorage` (cache, NUNCA autorização): guardamos só o token de
   sessão (`access_token`/`refresh_token`) localmente, para não pedir login
   toda vez que o app abre. O status de acesso em si (used_analyses,
   is_premium) NUNCA é lido do cache — a cada abertura do app, ele é buscado
   de novo no Supabase com o token válido. Ou seja: alguém poderia até editar
   o cache local à mão, mas isso não muda o que o Supabase devolve.

   Pagamento: `ACCESS_CONFIG.CHECKOUT_URL` é o único ponto de configuração
   do checkout. Hoje aponta para o checkout real da Cakto do VALE? PRO.
   Os dois pontos de entrada da assinatura — o CTA "Continuar com VALE? PRO"
   (tela de bloqueio) e o botão "Assinar VALE? PRO" (tela de oferta) —
   chamam `openCheckout()`, que abre esse link real em uma nova aba.

   IMPORTANTE — clique no checkout ≠ pagamento confirmado:
   Abrir o checkout NUNCA marca o usuário como PREMIUM. `is_premium` só pode
   ser alterado diretamente no banco (SQL) ou, futuramente, por um backend
   com a service_role key reagindo a um webhook real da Cakto — isso AINDA
   NÃO EXISTE neste MVP e não foi simulado. Ver a seção "REAL vs.
   DEMONSTRAÇÃO" logo abaixo de `ACCESS_CONFIG`.
   ========================================================================= */

// ---------------------------------------------------------------------------
// Configuração do Supabase (projeto "VALE") — fonte real de verdade do acesso
// ---------------------------------------------------------------------------
const SUPABASE_CONFIG = {
  URL: "https://yzfmchcrslqmsizfwzyr.supabase.co",
  // Chave anônima (legada, formato JWT) do projeto Supabase "VALE". É uma
  // chave PÚBLICA por natureza — protegida pelas policies de RLS do banco,
  // por isso pode viver no frontend com segurança.
  ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6Zm1jaGNyc2xxbXNpemZ3enlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMzUwNzMsImV4cCI6MjEwMzcxMTA3M30.kDvii-A6AK_UTY_QEI8vH-AMwBa6S8N-lEvS9kt5Dys",
};

// ---------------------------------------------------------------------------
// Configuração de acesso / monetização (única fonte de verdade)
// ---------------------------------------------------------------------------
const ACCESS_CONFIG = {
  FREE_ANALYSES_LIMIT: 3,
  PRICE_LABEL: "R$ 39/mês",
  PLAN_NAME: "VALE? PRO",
  // Checkout real do VALE? PRO na Cakto.
  CHECKOUT_URL: "https://pay.cakto.com.br/34qt8g9_1073973",
};

// Chave do cache LOCAL de sessão (só o token — nunca used_analyses/is_premium).
const SESSION_CACHE_KEY = "vale:session-v1";

// ---------------------------------------------------------------------------
// REAL vs. DEMONSTRAÇÃO — leia antes de mexer na monetização
// ---------------------------------------------------------------------------
// REAL (já em produção):
//   - Cadastro (nome + e-mail + senha) e login (e-mail + senha) via Supabase
//     Auth (projeto "VALE"). O nome vai para auth.users.user_metadata via
//     `data` no signup — nenhuma coluna nova em public.profiles.
//   - used_analyses e is_premium vivem em public.profiles no Supabase, com
//     RLS que só permite ao usuário LER a própria linha — nenhuma escrita
//     direta é possível pelo frontend. O único jeito de consumir uma
//     análise grátis é a função increment_used_analyses() (RPC), que só
//     mexe na própria linha do usuário autenticado e nunca toca is_premium.
//   - ACCESS_CONFIG.CHECKOUT_URL aponta para o checkout real da Cakto.
//     openCheckout() abre esse link real. Isso NUNCA marca o usuário como
//     PREMIUM sozinho.
//
// AINDA NÃO IMPLEMENTADO (depende de webhook/backend — próxima etapa):
//   - A confirmação automática de que um pagamento na Cakto foi aprovado.
//     Hoje, se alguém assinar, marcar is_premium = true precisa ser feito
//     manualmente no Supabase (SQL Editor: `update public.profiles set
//     is_premium = true where email = '...'`), porque não existe policy de
//     UPDATE para o cliente e nenhum webhook está conectado ainda. Quando o
//     webhook da Cakto for implementado, ele deverá rodar num backend com a
//     service_role key (nunca no frontend) e fazer exatamente esse update.
//
// DEMONSTRAÇÃO: não existe mais nenhum modo de demonstração local. Com o
// Supabase conectado, is_premium e used_analyses só mudam de verdade no
// banco — não há mais atalho de frontend para simular isso.
// ---------------------------------------------------------------------------
function openCheckout() {
  window.open(ACCESS_CONFIG.CHECKOUT_URL, "_blank", "noopener,noreferrer");
}

// --------------------------- Cache local de sessão --------------------------
// Guarda SÓ o token (access_token/refresh_token) — nunca used_analyses nem
// is_premium. Serve para não pedir login de novo a cada abertura do app; a
// autorização em si é sempre revalidada buscando o perfil no Supabase.
//
// Usa localStorage (padrão de qualquer navegador) — fora do sandbox do
// Claude Artifact não existe (nem é necessário) o window.storage.
async function loadCachedSession() {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function saveCachedSession(session) {
  try {
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session));
  } catch (e) {
    console.error("VALE?: não foi possível salvar a sessão localmente.", e);
  }
}

async function clearCachedSession() {
  try {
    localStorage.removeItem(SESSION_CACHE_KEY);
  } catch (e) {
    // nada salvo ainda — tudo bem
  }
}

// ------------------------ Supabase Auth (REST, sem SDK) ---------------------
function supaAuthHeaders(accessToken) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_CONFIG.ANON_KEY };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  return headers;
}

async function supaParseAuthError(res) {
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    // resposta sem corpo JSON
  }
  return new Error(data.error_description || data.msg || data.error || "Não foi possível completar a solicitação.");
}

async function supaSignUp(name, email, password) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/signup`, {
    method: "POST",
    headers: supaAuthHeaders(),
    // "name" vai em `data`, que o GoTrue guarda como user_metadata em
    // auth.users — não exige nenhuma coluna nova em public.profiles.
    body: JSON.stringify({ email, password, data: { name } }),
  });
  if (!res.ok) throw await supaParseAuthError(res);
  return res.json(); // { access_token?, refresh_token?, expires_in?, user } — sem tokens se precisar confirmar e-mail
}

async function supaSignIn(email, password) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: supaAuthHeaders(),
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await supaParseAuthError(res);
  return res.json(); // { access_token, refresh_token, expires_in, user }
}

async function supaRefreshSession(refreshToken) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: supaAuthHeaders(),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  return res.json();
}

async function supaSignOut(accessToken) {
  try {
    await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/logout`, {
      method: "POST",
      headers: supaAuthHeaders(accessToken),
    });
  } catch (e) {
    // best-effort — o cache local é limpo de qualquer forma
  }
}

function sessionFromAuthResponse(data) {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: nowSec + (data.expires_in || 3600),
    user: { id: data.user && data.user.id, email: data.user && data.user.email },
  };
}

// -------------------- Supabase REST (tabela profiles + RPC) -----------------
async function supaFetchProfile(accessToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/rest/v1/profiles?select=id,email,used_analyses,is_premium`,
    { headers: supaAuthHeaders(accessToken) }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}

// O trigger que cria a linha em public.profiles roda na mesma transação do
// cadastro, então normalmente já está pronta quando chegamos aqui — mas em
// caso de uma instabilidade momentânea de rede/replicação, tentamos mais
// uma vez antes de desistir, em vez de derrubar o usuário para a tela de
// login logo após ele ter acabado de entrar.
async function supaFetchProfileWithRetry(accessToken) {
  const first = await supaFetchProfile(accessToken);
  if (first) return first;
  await new Promise((resolve) => setTimeout(resolve, 500));
  return supaFetchProfile(accessToken);
}

async function supaIncrementUsedAnalyses(accessToken) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/rest/v1/rpc/increment_used_analyses`, {
    method: "POST",
    headers: supaAuthHeaders(accessToken),
    body: JSON.stringify({}),
  });
  if (!res.ok) return null;
  return res.json(); // linha atualizada de public.profiles
}

// Única função central que decide se uma nova análise pode começar.
function canStartAnalysis(access) {
  if (!access) return false;
  return access.status === "PREMIUM" || access.status === "FREE_ANALYSES_REMAINING";
}

// Única função central que registra 1 análise concluída. Só deve ser
// chamada depois que o resultado é efetivamente gerado (ver
// `handleAnalysisDone` no componente App). Consome o RPC do Supabase —
// nunca faz conta local. Se a chamada falhar (ex: sem internet), retorna
// null e o app simplesmente não atualiza o contador local nessa hora.
async function completeAnalysis(session) {
  if (!session) return null;
  try {
    return await supaIncrementUsedAnalyses(session.access_token);
  } catch (e) {
    console.error("VALE?: falha ao registrar análise concluída.", e);
    return null;
  }
}

// Deriva o status de acesso a partir do perfil vindo do Supabase.
function computeAccess(profile) {
  if (!profile) return null;
  if (profile.is_premium) return { status: "PREMIUM", remaining: null };

  const used = profile.used_analyses || 0;
  const remaining = Math.max(0, ACCESS_CONFIG.FREE_ANALYSES_LIMIT - used);

  if (remaining <= 0) return { status: "USED_ANALYSES", remaining: 0 };
  return { status: "FREE_ANALYSES_REMAINING", remaining };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const C = {
  bg: "#07080A",
  surface: "#12151A",
  surfaceRaised: "#181C22",
  surfaceInput: "#0D0F13",
  border: "#232830",
  borderStrong: "#323944",
  text: "#F3F5F7",
  muted: "#8B92A0",
  faint: "#565C66",
  gold: "#E8B94A",
  goldDim: "#8A6A2A",
  green: "#3ED598",
  greenDim: "#173327",
  red: "#FF5C5C",
  redDim: "#331A1A",
  amber: "#FFB84D",
  amberDim: "#332510",
};

const TONE = {
  good: { fg: C.green, bg: C.greenDim },
  warn: { fg: C.amber, bg: C.amberDim },
  bad: { fg: C.red, bg: C.redDim },
  neutral: { fg: C.muted, bg: C.surfaceInput },
};

// ---------------------------------------------------------------------------
// Ícones (formas simples e seguras, estilo linha, sem depender de libs)
// ---------------------------------------------------------------------------
function Icon({ size = 20, color = "currentColor", strokeWidth = 1.8, children, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {children}
    </svg>
  );
}

const SearchIcon = (p) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </Icon>
);
const ChevronLeftIcon = (p) => (
  <Icon {...p}>
    <polyline points="15 18 9 12 15 6" />
  </Icon>
);
const CarIcon = (p) => (
  <Icon {...p}>
    <path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11" />
    <rect x="3" y="11" width="18" height="6" rx="2" />
    <circle cx="7.5" cy="17.3" r="1.6" fill={p.color || "currentColor"} stroke="none" />
    <circle cx="16.5" cy="17.3" r="1.6" fill={p.color || "currentColor"} stroke="none" />
  </Icon>
);
const StarIcon = (p) => (
  <svg width={p.size || 20} height={p.size || 20} viewBox="0 0 24 24">
    <polygon
      points="12,2 14.9,8.6 22,9.3 16.5,14 18.2,21 12,17.3 5.8,21 7.5,14 2,9.3 9.1,8.6"
      fill={p.color || "currentColor"}
    />
  </svg>
);
const WalletIcon = (p) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2.2" />
    <path d="M3 10h18" />
    <circle cx="16.5" cy="14" r="1.1" fill={p.color || "currentColor"} stroke="none" />
  </Icon>
);
const GearIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.8 6.2l-1.7 1.7M7.9 16.1l-1.7 1.7M17.8 17.8l-1.7-1.7M7.9 7.9 6.2 6.2" />
  </Icon>
);
const TrendUpIcon = (p) => (
  <Icon {...p}>
    <polyline points="2 17 9 10 13 14 22 5" />
    <polyline points="16 5 22 5 22 11" />
  </Icon>
);
const GaugeSmallIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="12" x2="16" y2="8" />
    <circle cx="12" cy="12" r="1.2" fill={p.color || "currentColor"} stroke="none" />
  </Icon>
);
const AlertTriangleIcon = (p) => (
  <Icon {...p}>
    <polygon points="12 3 22 20 2 20" />
    <line x1="12" y1="9" x2="12" y2="14" />
    <circle cx="12" cy="17" r="1" fill={p.color || "currentColor"} stroke="none" />
  </Icon>
);
const CheckIcon = (p) => (
  <Icon {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Icon>
);
const BulbIcon = (p) => (
  <Icon {...p}>
    <circle cx="12" cy="10" r="5.2" />
    <path d="M9.6 19h4.8" />
    <path d="M10.2 21.5h3.6" />
    <line x1="12" y1="4.8" x2="12" y2="4.8" />
  </Icon>
);
const ShareIcon = (p) => (
  <Icon {...p}>
    <circle cx="18" cy="5" r="2.4" />
    <circle cx="6" cy="12" r="2.4" />
    <circle cx="18" cy="19" r="2.4" />
    <line x1="8.2" y1="10.7" x2="15.8" y2="6.5" />
    <line x1="8.2" y1="13.3" x2="15.8" y2="17.5" />
  </Icon>
);
const DocIcon = (p) => (
  <Icon {...p}>
    <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
    <line x1="8" y1="12" x2="16" y2="12" />
    <line x1="8" y1="16" x2="13" y2="16" />
  </Icon>
);
const LockIcon = (p) => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Icon>
);
const ZapIcon = (p) => (
  <svg width={p.size || 20} height={p.size || 20} viewBox="0 0 24 24">
    <polygon points="13,2 3,14 11,14 9,22 21,10 13,10" fill={p.color || "currentColor"} />
  </svg>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const digits = (s) => (s || "").replace(/\D/g, "");
const fmtThousands = (d) => (d ? Number(d).toLocaleString("pt-BR") : "");
const fmtBRL = (n) =>
  "R$ " + Math.round(n).toLocaleString("pt-BR", { maximumFractionDigits: 0 });

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

const CURRENT_YEAR = new Date().getFullYear();

function mockAnalyze(form) {
  const priceNum = Number(digits(form.price)) || 0;
  const kmNum = Number(digits(form.km)) || 0;
  const yearNum = Number(form.year) || CURRENT_YEAR;
  const age = Math.max(CURRENT_YEAR - yearNum, 0);

  const seed = hashStr(`${form.brand}|${form.model}|${form.year}`.toLowerCase().trim());
  const variance = ((seed % 1800) / 100) - 9; // ~ -9% .. +9%

  const referencePrice = priceNum > 0 ? Math.round(priceNum * (1 - variance / 100)) : 0;
  const diffPct =
    referencePrice > 0 ? ((priceNum - referencePrice) / referencePrice) * 100 : 0;

  let score = 7 - diffPct * 0.3;
  score = Math.max(0, Math.min(10, score));

  let verdictTone, verdictLabel;
  if (score >= 7.5) {
    verdictTone = "good";
    verdictLabel = "BOM NEGÓCIO";
  } else if (score >= 5.5) {
    verdictTone = "warn";
    verdictLabel = "NEGÓCIO OK";
  } else {
    verdictTone = "bad";
    verdictLabel = "ATENÇÃO AO PREÇO";
  }

  let verdictText;
  if (diffPct <= -5) {
    verdictText = `O preço informado está ${Math.abs(diffPct).toFixed(
      1
    )}% abaixo da referência utilizada na análise. O veículo pode representar uma oportunidade — ainda assim, vale confirmar o estado geral do carro antes de fechar negócio.`;
  } else if (diffPct >= 5) {
    verdictText = `O preço informado está ${diffPct.toFixed(
      1
    )}% acima da referência utilizada na análise. Vale negociar ou entender o que justifica esse valor antes de avançar.`;
  } else {
    verdictText = `O preço informado está próximo da referência utilizada na análise — um valor dentro do esperado. A decisão pode depender mais do estado de conservação do que do preço em si.`;
  }

  // Preço — calculado a partir do valor informado vs. referência simulada
  const precoTone = diffPct <= -5 ? "good" : diffPct < 5 ? "warn" : "bad";
  const precoLabel = diffPct <= -5 ? "Bom" : diffPct < 5 ? "Regular" : "Alto";

  // Quilometragem — calculada a partir da idade do veículo vs. km informado
  const expectedKm = Math.max(age, 1) * 15000;
  const ratio = expectedKm > 0 ? kmNum / expectedKm : 0;
  let kmTone, kmLabel;
  if (ratio > 1.25) {
    kmTone = "bad";
    kmLabel = "Alta";
  } else if (ratio > 0.9) {
    kmTone = "warn";
    kmLabel = "Atenção";
  } else {
    kmTone = "good";
    kmLabel = "Baixa";
  }

  // Manutenção e Revenda: ainda não existe fonte de dados real para isso.
  // Em vez de inventar uma avaliação, mostramos claramente que faltam dados.
  const manutTone = "neutral";
  const manutLabel = "Dados insuficientes";
  const revendaTone = "neutral";
  const revendaLabel = "Dados insuficientes";

  return {
    score,
    verdictTone,
    verdictLabel,
    referencePrice,
    diffPct,
    verdictText,
    priceNum,
    kmNum,
    yearNum,
    isSimulated: true,
    indicators: [
      { key: "preco", label: "Preço", value: precoLabel, tone: precoTone, Icon: WalletIcon },
      { key: "manut", label: "Manutenção", value: manutLabel, tone: manutTone, Icon: GearIcon },
      { key: "revenda", label: "Revenda", value: revendaLabel, tone: revendaTone, Icon: TrendUpIcon },
      { key: "km", label: "Quilometragem", value: kmLabel, tone: kmTone, Icon: GaugeSmallIcon },
    ],
  };
}

// ---------------------------------------------------------------------------
// Componentes visuais compartilhados
// ---------------------------------------------------------------------------
function ScoreGauge({ score, tone }) {
  const size = 200;
  const r = 82;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const sweep = 0.75; // 270 graus
  const trackLen = circ * sweep;
  const gapLen = circ - trackLen;
  const progress = Math.max(0, Math.min(1, score / 10)) * trackLen;
  const color = TONE[tone].fg;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(135deg)" }}>
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={C.border}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${trackLen} ${gapLen}`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${circ - progress}`}
          style={{ transition: "stroke-dasharray 900ms cubic-bezier(.2,.8,.2,1)", filter: `drop-shadow(0 0 10px ${color}55)` }}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 44,
              fontWeight: 600,
              color: C.text,
              letterSpacing: -1,
            }}
          >
            {score.toFixed(1)}
          </span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 15, color: C.muted }}>
            /10
          </span>
        </div>
        <div style={{ display: "flex", gap: 3, marginTop: 4 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <StarIcon key={i} size={12} color={i < Math.round(score / 2) ? C.gold : C.border} />
          ))}
        </div>
      </div>
    </div>
  );
}

function IndicatorChip({ icon: IconComp, label, value, tone }) {
  const t = TONE[tone];
  return (
    <div
      style={{
        background: C.surfaceRaised,
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        padding: "14px 14px",
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          background: t.bg,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <IconComp size={17} color={t.fg} strokeWidth={2} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 2 }}>{label}</div>
        <div
          style={{
            fontSize: value === "Dados insuficientes" ? 12.5 : 14.5,
            fontWeight: 600,
            color: t.fg,
            fontFamily: "'Rajdhani', sans-serif",
            letterSpacing: 0.3,
            lineHeight: 1.25,
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label
        style={{
          fontSize: 11.5,
          fontWeight: 600,
          letterSpacing: 1,
          textTransform: "uppercase",
          color: C.muted,
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

const inputBase = {
  width: "100%",
  boxSizing: "border-box",
  background: C.surfaceInput,
  border: `1px solid ${C.border}`,
  borderRadius: 14,
  padding: "14px 16px",
  fontSize: 16,
  color: C.text,
  fontFamily: "'Inter', sans-serif",
  outline: "none",
};

function TextField({ value, onChange, placeholder, inputMode, maxLength, prefix, type = "text", autoComplete }) {
  const [focused, setFocused] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {prefix && (
        <span
          style={{
            position: "absolute",
            left: 16,
            top: "50%",
            transform: "translateY(-50%)",
            color: value ? C.text : C.faint,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 15,
            fontWeight: 600,
            pointerEvents: "none",
          }}
        >
          {prefix}
        </span>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        autoComplete={autoComplete}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputBase,
          paddingLeft: prefix ? 40 : 16,
          borderColor: focused ? C.gold : C.border,
          boxShadow: focused ? `0 0 0 3px ${C.gold}22` : "none",
          fontFamily: inputMode === "numeric" ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
          transition: "border-color 160ms, box-shadow 160ms",
        }}
      />
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        border: "none",
        borderRadius: 16,
        padding: "17px 20px",
        background: disabled
          ? C.surfaceRaised
          : `linear-gradient(135deg, ${C.gold}, #C99A34)`,
        color: disabled ? C.faint : "#171006",
        fontFamily: "'Rajdhani', sans-serif",
        fontWeight: 700,
        fontSize: 16.5,
        letterSpacing: 1.1,
        textTransform: "uppercase",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        cursor: disabled ? "not-allowed" : "pointer",
        boxShadow: disabled ? "none" : `0 8px 24px -8px ${C.gold}88`,
        transition: "transform 120ms ease",
      }}
      onMouseDown={(e) => !disabled && (e.currentTarget.style.transform = "scale(0.98)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      {icon}
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick, style }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: "100%",
        border: `1px solid ${C.border}`,
        borderRadius: 16,
        padding: "15px 20px",
        background: "transparent",
        color: C.text,
        fontFamily: "'Rajdhani', sans-serif",
        fontWeight: 600,
        fontSize: 15.5,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function GhostLink({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        color: C.faint,
        fontSize: 12.5,
        fontFamily: "'Inter', sans-serif",
        textDecoration: "underline",
        textUnderlineOffset: 3,
        cursor: "pointer",
        padding: 6,
      }}
    >
      {children}
    </button>
  );
}

function BackHeader({ onBack, title, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
      <button
        onClick={onBack}
        aria-label="Voltar"
        style={{
          width: 38,
          height: 38,
          minWidth: 38,
          borderRadius: 12,
          background: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <ChevronLeftIcon size={19} color={C.text} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <span
          style={{
            fontFamily: "'Rajdhani', sans-serif",
            fontWeight: 700,
            fontSize: 17,
            color: C.text,
            letterSpacing: 0.3,
          }}
        >
          {title}
        </span>
      </div>
      {right}
    </div>
  );
}

function Logo({ size = 30 }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.3,
          background: `linear-gradient(135deg, ${C.gold}, #B9862A)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: `0 4px 14px -4px ${C.gold}99`,
        }}
      >
        <GaugeSmallIcon size={size * 0.58} color="#171006" strokeWidth={2.2} />
      </div>
      <span
        style={{
          fontFamily: "'Rajdhani', sans-serif",
          fontWeight: 700,
          fontSize: size * 0.62,
          color: C.text,
          letterSpacing: 0.5,
        }}
      >
        VALE<span style={{ color: C.gold }}>?</span>
      </span>
    </div>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return (
    <div
      style={{
        position: "absolute",
        bottom: 108,
        left: "50%",
        transform: "translateX(-50%)",
        background: C.surfaceRaised,
        border: `1px solid ${C.borderStrong}`,
        color: C.text,
        fontSize: 13.5,
        fontFamily: "'Inter', sans-serif",
        padding: "10px 16px",
        borderRadius: 12,
        boxShadow: "0 10px 30px -10px rgba(0,0,0,0.6)",
        zIndex: 50,
        animation: "vale-toast-in 220ms ease",
        whiteSpace: "nowrap",
      }}
    >
      {message}
    </div>
  );
}

// Selo discreto de acesso (análises grátis / PRO) — nunca é um contador
// falso, é sempre derivado de computeAccess() a partir da contagem real.
function AccessBadge({ access }) {
  if (!access) return null;

  if (access.status === "PREMIUM") {
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          background: `linear-gradient(135deg, ${C.gold}22, ${C.gold}11)`,
          border: `1px solid ${C.gold}55`,
          color: C.gold,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.8,
          padding: "6px 10px",
          borderRadius: 999,
          fontFamily: "'Rajdhani', sans-serif",
        }}
      >
        <ZapIcon size={11} color={C.gold} />
        VALE? PRO
      </div>
    );
  }

  if (access.status === "FREE_ANALYSES_REMAINING") {
    const label =
      access.remaining === 1 ? "1 análise grátis restante" : `${access.remaining} análises grátis restantes`;
    return (
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: C.surfaceRaised,
          border: `1px solid ${C.border}`,
          color: C.muted,
          fontSize: 11,
          fontWeight: 500,
          padding: "6px 10px",
          borderRadius: 999,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: C.green }} />
        {label}
      </div>
    );
  }

  // USED_ANALYSES: as gratuitas acabaram e o usuário ainda não é premium.
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: C.surfaceRaised,
        border: `1px solid ${C.border}`,
        color: C.faint,
        fontSize: 11,
        fontWeight: 500,
        padding: "6px 10px",
        borderRadius: 999,
      }}
    >
      VALE? PRO
    </div>
  );
}

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------
function LoadingScreen() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
      }}
    >
      <div
        style={{
          width: 46,
          height: 46,
          borderRadius: 14,
          border: `2px solid ${C.border}`,
          borderTopColor: C.gold,
          animation: "vale-spin 800ms linear infinite",
        }}
      />
    </div>
  );
}

function AuthScreen({ onSignUp, onSignIn }) {
  const [mode, setMode] = useState("signup"); // 'signup' | 'login'
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  const isSignup = mode === "signup";
  const canSubmit =
    (!isSignup || name.trim().length > 0) && email.trim().length > 3 && password.length >= 6 && !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setLoading(true);
    setError("");
    try {
      if (isSignup) {
        const result = await onSignUp(name.trim(), email.trim(), password);
        if (!result || !result.confirmed) {
          setAwaitingConfirmation(true);
        }
      } else {
        await onSignIn(email.trim(), password);
      }
    } catch (e) {
      setError(e.message || "Não foi possível completar a solicitação.");
    } finally {
      setLoading(false);
    }
  };

  if (awaitingConfirmation) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          gap: 18,
          padding: "0 24px 28px",
          animation: "vale-fade-in 380ms ease",
        }}
      >
        <Logo size={36} />
        <h1
          style={{
            fontFamily: "'Rajdhani', sans-serif",
            fontWeight: 700,
            fontSize: 22,
            color: C.text,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.3,
          }}
        >
          Confirme seu e-mail
        </h1>
        <p style={{ fontSize: 14, color: C.muted, margin: 0, maxWidth: 290, lineHeight: 1.6 }}>
          Enviamos um link de confirmação para <strong style={{ color: C.text }}>{email.trim()}</strong>. Confirme
          para poder entrar no VALE?.
        </p>
        <GhostLink
          onClick={() => {
            setAwaitingConfirmation(false);
            setMode("login");
            setPassword("");
          }}
        >
          Voltar para o login
        </GhostLink>
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "0 24px 28px",
        animation: "vale-fade-in 380ms ease",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 20 }}>
          <Logo size={40} />
          {isSignup && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                background: `${C.green}15`,
                border: `1px solid ${C.green}44`,
                color: C.green,
                fontSize: 12,
                fontWeight: 600,
                padding: "6px 12px",
                borderRadius: 999,
              }}
            >
              <ZapIcon size={12} color={C.green} />
              3 análises grátis, sem compromisso
            </div>
          )}
          <h1
            style={{
              fontFamily: "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 27,
              color: C.text,
              margin: 0,
              maxWidth: 300,
              lineHeight: 1.3,
            }}
          >
            {isSignup ? "Crie sua conta grátis." : "Bem-vindo de volta."}
          </h1>
          <p style={{ fontSize: 14.5, color: C.muted, margin: 0, maxWidth: 290, lineHeight: 1.6 }}>
            {isSignup
              ? "Faça suas análises e descubra se o preço daquele carro realmente vale a pena."
              : "Entre para continuar suas análises de onde parou."}
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 6 }}>
          {isSignup && (
            <Field label="Nome">
              <TextField
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                autoComplete="name"
              />
            </Field>
          )}
          <Field label="E-mail">
            <TextField
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@email.com"
              inputMode="email"
              autoComplete="email"
            />
          </Field>
          <Field label="Senha">
            <TextField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              type="password"
              autoComplete={isSignup ? "new-password" : "current-password"}
            />
          </Field>
          {error && (
            <p style={{ fontSize: 12.5, color: C.red, margin: 0, lineHeight: 1.5 }}>{error}</p>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <PrimaryButton onClick={handleSubmit} disabled={!canSubmit} icon={<ZapIcon size={17} color="#171006" />}>
          {loading ? "Um instante…" : isSignup ? "Criar conta" : "Entrar"}
        </PrimaryButton>
        <GhostLink
          onClick={() => {
            setMode(isSignup ? "login" : "signup");
            setError("");
          }}
        >
          {isSignup ? "Já tem conta? Entrar" : "Não tem conta? Criar uma"}
        </GhostLink>
      </div>
    </div>
  );
}

function HomeScreen({ onStart, access, onLogout }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "0 24px 28px",
        animation: "vale-fade-in 380ms ease",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: 22 }}>
        <div
          style={{
            width: 84,
            height: 84,
            borderRadius: 24,
            background: `radial-gradient(circle at 30% 25%, #2a2210, ${C.surface})`,
            border: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 4,
          }}
        >
          <GaugeSmallIcon size={40} color={C.gold} strokeWidth={1.6} />
        </div>

        <div>
          <h1
            style={{
              fontFamily: "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 52,
              letterSpacing: 1,
              margin: 0,
              color: C.text,
              lineHeight: 1,
            }}
          >
            VALE<span style={{ color: C.gold }}>?</span>
          </h1>
        </div>

        <p
          style={{
            fontFamily: "'Rajdhani', sans-serif",
            fontWeight: 600,
            fontSize: 19,
            color: C.text,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.35,
          }}
        >
          Antes de comprar, descubra se vale a pena.
        </p>

        <p style={{ fontSize: 14.5, color: C.muted, margin: 0, maxWidth: 280, lineHeight: 1.6 }}>
          Analise o preço de um carro usado e veja se o negócio parece realmente bom.
        </p>

        <AccessBadge access={access} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <PrimaryButton onClick={onStart} icon={<SearchIcon size={19} color="#171006" strokeWidth={2.2} />}>
          Analisar meu carro
        </PrimaryButton>
        <p style={{ fontSize: 11.5, color: C.faint, textAlign: "center", margin: 0, lineHeight: 1.5 }}>
          Análise de referência — não substitui avaliação profissional.
        </p>
        <div style={{ textAlign: "center" }}>
          <GhostLink onClick={onLogout}>Sair</GhostLink>
        </div>
      </div>
    </div>
  );
}

function FormScreen({ form, setForm, onSubmit, onBack }) {
  const canAnalyze =
    form.brand.trim().length > 0 &&
    form.model.trim().length > 0 &&
    form.year.length === 4 &&
    digits(form.km).length > 0 &&
    digits(form.price).length > 0;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="Dados do veículo" />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1.3 }}>
            <Field label="Marca">
              <TextField
                value={form.brand}
                onChange={(e) => setForm((f) => ({ ...f, brand: e.target.value }))}
                placeholder="Ex: Toyota"
              />
            </Field>
          </div>
          <div style={{ flex: 1.7 }}>
            <Field label="Modelo">
              <TextField
                value={form.model}
                onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
                placeholder="Ex: Corolla XEi"
              />
            </Field>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Ano">
              <TextField
                value={form.year}
                onChange={(e) => setForm((f) => ({ ...f, year: digits(e.target.value).slice(0, 4) }))}
                placeholder="2019"
                inputMode="numeric"
                maxLength={4}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Quilometragem">
              <TextField
                value={form.km}
                onChange={(e) => setForm((f) => ({ ...f, km: fmtThousands(digits(e.target.value)) }))}
                placeholder="45.000"
                inputMode="numeric"
              />
            </Field>
          </div>
        </div>

        <Field label="Preço anunciado">
          <TextField
            value={form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: fmtThousands(digits(e.target.value)) }))}
            placeholder="62.000"
            inputMode="numeric"
            prefix="R$"
          />
        </Field>

        <p style={{ fontSize: 11.5, color: C.faint, margin: "4px 2px 0", lineHeight: 1.5 }}>
          Marca, modelo e ano ficam prontos para serem preenchidos futuramente por uma base automotiva.
        </p>
      </div>

      <div style={{ marginTop: 20 }}>
        <PrimaryButton onClick={onSubmit} disabled={!canAnalyze}>
          Analisar carro
        </PrimaryButton>
      </div>
    </div>
  );
}

const ANALYZING_MESSAGES = [
  "Lendo os dados do veículo…",
  "Comparando com a referência…",
  "Calculando a nota…",
];

function AnalyzingScreen({ onDone }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    const stepTimer = setInterval(() => {
      setStep((s) => Math.min(s + 1, ANALYZING_MESSAGES.length - 1));
    }, 480);
    const doneTimer = setTimeout(onDone, 1450);
    return () => {
      clearInterval(stepTimer);
      clearTimeout(doneTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
        padding: "0 24px",
      }}
    >
      <div style={{ position: "relative", width: 76, height: 76 }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `3px solid ${C.border}`,
            borderTopColor: C.gold,
            animation: "vale-spin 900ms linear infinite",
          }}
        />
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <GaugeSmallIcon size={28} color={C.gold} strokeWidth={1.6} />
        </div>
      </div>
      <span
        key={step}
        style={{
          fontFamily: "'Rajdhani', sans-serif",
          fontWeight: 600,
          fontSize: 16,
          color: C.muted,
          animation: "vale-fade-in 250ms ease",
        }}
      >
        {ANALYZING_MESSAGES[step]}
      </span>
    </div>
  );
}

function Row({ label, value, muted, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 13.5, color: C.muted }}>{label}</span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 15.5,
          fontWeight: 600,
          color: valueColor || (muted ? C.muted : C.text),
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ResultScreen({ form, result, onBack, onRestart }) {
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  };

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const handleShare = async () => {
    const text = `VALE?\n${form.brand} ${form.model} · ${form.year}\n${result.score.toFixed(1)}/10 — ${
      result.verdictLabel
    }\n${fmtBRL(result.priceNum)}\nAnalisado pelo VALE?`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Minha análise VALE?", text });
      } else {
        await navigator.clipboard.writeText(text);
        showToast("Análise copiada!");
      }
    } catch (e) {
      // usuário cancelou o compartilhamento — nada a fazer
    }
  };

  const tone = TONE[result.verdictTone];
  const diffLabel = `${result.diffPct >= 0 ? "+" : ""}${result.diffPct.toFixed(1)}%`;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", position: "relative", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="Resultado da análise" />

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, paddingBottom: 4 }}>
        {/* Veículo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 12,
              background: C.surfaceRaised,
              border: `1px solid ${C.border}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CarIcon size={20} color={C.gold} />
          </div>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 19, color: C.text }}>
            {form.brand} {form.model} <span style={{ color: C.muted }}>· {form.year}</span>
          </div>
        </div>

        {/* Gauge + veredito */}
        <div
          style={{
            background: `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            border: `1px solid ${C.border}`,
            borderRadius: 22,
            padding: "26px 20px 22px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            animation: "vale-fade-in 420ms ease",
          }}
        >
          <ScoreGauge score={result.score} tone={result.verdictTone} />
          <div
            style={{
              marginTop: 6,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: tone.bg,
              color: tone.fg,
              border: `1px solid ${tone.fg}33`,
              padding: "8px 18px",
              borderRadius: 999,
              fontFamily: "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 15.5,
              letterSpacing: 1,
            }}
          >
            {result.verdictTone === "bad" ? (
              <AlertTriangleIcon size={15} color={tone.fg} strokeWidth={2.2} />
            ) : (
              <CheckIcon size={15} color={tone.fg} strokeWidth={2.6} />
            )}
            {result.verdictLabel}
          </div>
        </div>

        {/* Preços */}
        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            animation: "vale-fade-in 460ms ease",
          }}
        >
          <Row label="Preço anunciado" value={fmtBRL(result.priceNum)} />
          <div style={{ height: 1, background: C.border }} />
          <Row label="Preço de referência" value={fmtBRL(result.referencePrice)} muted />
          <div style={{ height: 1, background: C.border }} />
          <Row
            label="Diferença"
            value={diffLabel}
            valueColor={result.diffPct <= -5 ? C.green : result.diffPct >= 5 ? C.red : C.amber}
          />
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginTop: 2,
              fontSize: 11,
              color: C.faint,
            }}
          >
            <span
              style={{
                background: C.surfaceInput,
                border: `1px solid ${C.border}`,
                borderRadius: 999,
                padding: "3px 9px",
                letterSpacing: 0.4,
              }}
            >
              REFERÊNCIA SIMULADA
            </span>
            <span>preparado para receber dados reais de uma API automotiva</span>
          </div>
        </div>

        {/* Indicadores */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, animation: "vale-fade-in 500ms ease" }}>
          {result.indicators.map((ind) => (
            <IndicatorChip key={ind.key} icon={ind.Icon} label={ind.label} value={ind.value} tone={ind.tone} />
          ))}
        </div>

        {/* Veredito */}
        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            animation: "vale-fade-in 540ms ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <BulbIcon size={17} color={C.gold} strokeWidth={1.8} />
            <span
              style={{
                fontFamily: "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: 14.5,
                letterSpacing: 1,
                color: C.text,
                textTransform: "uppercase",
              }}
            >
              Nosso veredito
            </span>
          </div>
          <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.65, margin: 0 }}>{result.verdictText}</p>
        </div>

        {/* Checklist */}
        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            animation: "vale-fade-in 580ms ease",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <AlertTriangleIcon size={16} color={C.amber} strokeWidth={2} />
            <span
              style={{
                fontFamily: "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: 14.5,
                letterSpacing: 1,
                color: C.text,
                textTransform: "uppercase",
              }}
            >
              Antes de comprar
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              "Faça avaliação mecânica",
              "Verifique histórico de manutenção",
              "Faça laudo cautelar",
              "Confira documentação",
              "Faça um test-drive",
            ].map((item) => (
              <div key={item} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  style={{
                    width: 20,
                    height: 20,
                    minWidth: 20,
                    borderRadius: 7,
                    background: C.greenDim,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <CheckIcon size={12} color={C.green} strokeWidth={2.8} />
                </div>
                <span style={{ fontSize: 13.8, color: C.text }}>{item}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "2px 4px" }}>
          <DocIcon size={14} color={C.faint} style={{ marginTop: 2, flexShrink: 0 }} />
          <p style={{ fontSize: 11.5, color: C.faint, lineHeight: 1.6, margin: 0 }}>
            O VALE? fornece uma análise de referência e não substitui uma avaliação profissional do veículo.
          </p>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 16 }}>
        <PrimaryButton onClick={handleShare} icon={<ShareIcon size={18} color="#171006" strokeWidth={2} />}>
          Compartilhar análise
        </PrimaryButton>
        <SecondaryButton onClick={onRestart}>Nova análise</SecondaryButton>
      </div>

      <Toast message={toast} />
    </div>
  );
}

function PaywallScreen({ onContinue, onDismiss }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "0 24px 24px",
        animation: "vale-fade-in 380ms ease",
      }}
    >
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          gap: 16,
          paddingTop: 12,
        }}
      >
        <div
          style={{
            width: 68,
            height: 68,
            borderRadius: 20,
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LockIcon size={28} color={C.gold} strokeWidth={1.7} />
        </div>

        <h1
          style={{
            fontFamily: "'Rajdhani', sans-serif",
            fontWeight: 700,
            fontSize: 24,
            color: C.text,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.3,
          }}
        >
          Suas 3 análises gratuitas terminaram
        </h1>

        <p style={{ fontSize: 14, color: C.muted, margin: 0, maxWidth: 300, lineHeight: 1.65 }}>
          Você já experimentou o VALE?. Continue analisando carros e descubra se realmente vale a pena antes de
          comprar.
        </p>

        <div
          style={{
            marginTop: 6,
            width: "100%",
            background: C.surfaceRaised,
            border: `1px solid ${C.gold}44`,
            borderRadius: 18,
            padding: "16px 18px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ textAlign: "left" }}>
            <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 16, color: C.gold }}>
              {ACCESS_CONFIG.PLAN_NAME}
            </div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2 }}>Análises ilimitadas</div>
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 17, color: C.text }}>
            {ACCESS_CONFIG.PRICE_LABEL}
          </div>
        </div>

        <div
          style={{
            width: "100%",
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 11,
            textAlign: "left",
          }}
        >
          {PAYWALL_BENEFITS.map((b) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 18,
                  height: 18,
                  minWidth: 18,
                  borderRadius: 6,
                  background: C.greenDim,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CheckIcon size={11} color={C.green} strokeWidth={2.8} />
              </div>
              <span style={{ fontSize: 13.5, color: C.text }}>{b}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", marginTop: 16 }}>
        <PrimaryButton onClick={onContinue} icon={<ZapIcon size={17} color="#171006" />}>
          Continuar com VALE? PRO
        </PrimaryButton>
        <SecondaryButton onClick={onDismiss} style={{ border: "none" }}>
          Agora não
        </SecondaryButton>
      </div>
    </div>
  );
}

const PAYWALL_BENEFITS = [
  "Novas análises de veículos",
  "Análise de preço",
  "Comparação com preço de referência",
  "Indicadores do veículo",
  "Veredito antes da compra",
];

const PRO_BENEFITS = [
  "Análises ilimitadas",
  "Comparação com preço de referência",
  "Nota de 0 a 10",
  "Indicadores da análise",
  "Veredito do VALE?",
  "Compartilhamento das análises",
];

function OfferScreen({ onBack, onSubscribe }) {
  const demoMode = !ACCESS_CONFIG.CHECKOUT_URL;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="VALE? PRO" />

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18, paddingBottom: 4 }}>
        <div style={{ textAlign: "center", padding: "6px 4px 2px" }}>
          <h1
            style={{
              fontFamily: "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 24,
              color: C.text,
              margin: "0 0 10px",
              lineHeight: 1.3,
            }}
          >
            Continue descobrindo se vale a pena.
          </h1>
          <p style={{ fontSize: 13.5, color: C.muted, margin: 0, lineHeight: 1.6 }}>
            Tenha acesso às análises do VALE? e tome decisões mais inteligentes antes de comprar seu próximo carro.
          </p>
        </div>

        <div
          style={{
            background: `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            border: `1px solid ${C.gold}44`,
            borderRadius: 20,
            padding: "20px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: C.gold, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 17, letterSpacing: 0.5 }}>
            <ZapIcon size={15} color={C.gold} />
            {ACCESS_CONFIG.PLAN_NAME}
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, fontSize: 32, color: C.text, marginTop: 8 }}>
            {ACCESS_CONFIG.PRICE_LABEL}
          </div>
        </div>

        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            display: "flex",
            flexDirection: "column",
            gap: 13,
          }}
        >
          {PRO_BENEFITS.map((b) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 20,
                  height: 20,
                  minWidth: 20,
                  borderRadius: 7,
                  background: C.greenDim,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <CheckIcon size={12} color={C.green} strokeWidth={2.8} />
              </div>
              <span style={{ fontSize: 14, color: C.text }}>{b}</span>
            </div>
          ))}
        </div>

        {demoMode && (
          <div
            style={{
              border: `1px dashed ${C.border}`,
              borderRadius: 14,
              padding: "10px 14px",
              fontSize: 11.5,
              color: C.faint,
              lineHeight: 1.5,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            CHECKOUT_URL não configurada — este botão ativa um modo de demonstração local para testar o fluxo.
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, alignItems: "center" }}>
        <PrimaryButton onClick={onSubscribe} icon={<ZapIcon size={17} color="#171006" />}>
          Assinar VALE? PRO
        </PrimaryButton>
        <p style={{ fontSize: 11, color: C.faint, margin: 0, textAlign: "center" }}>
          Pagamento realizado através do checkout.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const emptyForm = { brand: "", model: "", year: "", km: "", price: "" };

export default function App() {
  const [screen, setScreen] = useState("loading");
  // 'loading' | 'auth' | 'home' | 'form' | 'analyzing' | 'result' | 'paywall' | 'offer'
  const [form, setForm] = useState(emptyForm);
  const [analyzedForm, setAnalyzedForm] = useState(null);
  const [session, setSession] = useState(null); // { access_token, refresh_token, expires_at, user } | null
  const [profile, setProfile] = useState(null); // linha de public.profiles vinda do Supabase | null

  // Ao abrir o app: tenta reaproveitar a sessão salva localmente (só o
  // token), renova se necessário, e SEMPRE busca o perfil de novo no
  // Supabase — o cache nunca decide sozinho se o usuário tem acesso.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const cached = await loadCachedSession();
      if (!cached) {
        if (mounted) setScreen("auth");
        return;
      }

      let activeSession = cached;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!cached.expires_at || cached.expires_at <= nowSec + 30) {
        const refreshed = await supaRefreshSession(cached.refresh_token);
        if (!refreshed) {
          await clearCachedSession();
          if (mounted) setScreen("auth");
          return;
        }
        activeSession = sessionFromAuthResponse(refreshed);
        await saveCachedSession(activeSession);
      }

      const freshProfile = await supaFetchProfileWithRetry(activeSession.access_token);
      if (!mounted) return;
      if (!freshProfile) {
        // Token inválido/perfil não encontrado -> pede login de novo.
        await clearCachedSession();
        setScreen("auth");
        return;
      }
      setSession(activeSession);
      setProfile(freshProfile);
      setScreen("home");
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const access = useMemo(() => computeAccess(profile), [profile]);
  const result = useMemo(
    () => (screen === "result" && analyzedForm ? mockAnalyze(analyzedForm) : null),
    [screen, analyzedForm]
  );

  // Depois de um cadastro (com confirmação de e-mail desativada) ou login
  // bem-sucedido: guarda a sessão (cache local) e busca o perfil de
  // verdade no Supabase antes de liberar a Home.
  const establishSession = async (authData) => {
    const newSession = sessionFromAuthResponse(authData);
    setSession(newSession);
    await saveCachedSession(newSession);
    const freshProfile = await supaFetchProfileWithRetry(newSession.access_token);
    setProfile(freshProfile);
    setScreen("home");
  };

  const handleSignUp = async (name, email, password) => {
    const data = await supaSignUp(name, email, password);
    if (data && data.access_token) {
      await establishSession(data);
      return { confirmed: true };
    }
    // Sem access_token = o projeto exige confirmação por e-mail antes do
    // primeiro login. O perfil já existe (criado pelo trigger), só falta
    // a pessoa confirmar e fazer login normalmente.
    return { confirmed: false };
  };

  const handleSignIn = async (email, password) => {
    const data = await supaSignIn(email, password);
    await establishSession(data);
  };

  const handleLogout = async () => {
    if (session) await supaSignOut(session.access_token);
    await clearCachedSession();
    setSession(null);
    setProfile(null);
    setForm(emptyForm);
    setAnalyzedForm(null);
    setScreen("auth");
  };

  const requestAnalysis = () => {
    if (!canStartAnalysis(access)) {
      setScreen("paywall");
    } else {
      setScreen("form");
    }
  };

  const handleSubmitForm = () => {
    setScreen("analyzing");
  };

  const handleAnalysisDone = () => {
    setAnalyzedForm(form);
    setScreen("result");
    // A análise só é contabilizada agora que o resultado foi efetivamente
    // gerado — se o usuário tivesse voltado ou saído antes disso, nada
    // seria descontado. O Supabase (RPC increment_used_analyses) é quem
    // decide de verdade o novo valor; só refletimos a resposta dele aqui.
    completeAnalysis(session).then((updated) => {
      if (updated) setProfile(updated);
    });
  };

  const handleNewAnalysis = () => {
    if (!canStartAnalysis(access)) {
      setScreen("paywall");
      return;
    }
    setForm(emptyForm);
    setScreen("form");
  };

  // Usado tanto pelo CTA "Continuar com VALE? PRO" (paywall) quanto pelo
  // botão "Assinar VALE? PRO" (oferta) — ambos levam ao mesmo checkout real.
  const handleSubscribe = () => {
    openCheckout();
    // Importante: abrir o checkout NÃO confirma pagamento. is_premium só
    // pode ser alterado no Supabase (manualmente por enquanto, ou por um
    // backend com service_role reagindo a um webhook real da Cakto no
    // futuro) — nada é ativado aqui no frontend.
  };

  const showHeader = screen === "home";

  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background: `radial-gradient(120% 60% at 50% -10%, #16130a 0%, ${C.bg} 55%)`,
        display: "flex",
        justifyContent: "center",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

        * { box-sizing: border-box; }
        input::placeholder { color: ${C.faint}; }
        input:focus { outline: none; }
        button { font-family: inherit; }

        @keyframes vale-fade-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes vale-slide-in {
          from { opacity: 0; transform: translateX(10px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes vale-toast-in {
          from { opacity: 0; transform: translate(-50%, 6px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        @keyframes vale-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
      `}</style>

      <div
        style={{
          width: "100%",
          maxWidth: 430,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          position: "relative",
        }}
      >
        {showHeader && (
          <div style={{ padding: "22px 24px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Logo />
          </div>
        )}

        {screen === "loading" && <LoadingScreen />}

        {screen === "auth" && <AuthScreen onSignUp={handleSignUp} onSignIn={handleSignIn} />}

        {screen === "home" && <HomeScreen onStart={requestAnalysis} access={access} onLogout={handleLogout} />}

        {screen === "form" && (
          <div style={{ paddingTop: 22 }}>
            <FormScreen form={form} setForm={setForm} onSubmit={handleSubmitForm} onBack={() => setScreen("home")} />
          </div>
        )}

        {screen === "analyzing" && <AnalyzingScreen onDone={handleAnalysisDone} />}

        {screen === "result" && result && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <ResultScreen
              form={analyzedForm}
              result={result}
              onBack={() => setScreen("form")}
              onRestart={handleNewAnalysis}
            />
          </div>
        )}

        {screen === "paywall" && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <PaywallScreen onContinue={handleSubscribe} onDismiss={() => setScreen("home")} />
          </div>
        )}

        {screen === "offer" && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <OfferScreen onBack={() => setScreen("paywall")} onSubscribe={handleSubscribe} />
          </div>
        )}
      </div>
    </div>
  );
}
