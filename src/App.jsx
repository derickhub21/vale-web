import React, { useState, useMemo, useRef, useEffect } from "react";

/* =========================================================================
   VALE? — MVP
   "Antes de comprar, descubra se vale a pena."

   ARQUITETURA DE DADOS
   -------------------------------------------------------------------------
   O preço de referência vem 100% da FIPE de verdade, via a Edge Function
   `dynamic-service` do Supabase (que por sua vez consulta a API da FIPE —
   a chave dela fica só no backend, nunca aqui). Fluxo, disparado pelo
   clique em "Analisar carro":

   1. `fetchFipeDetail(form.brandId, form.modelId, form.yearId, accessToken)`
      busca o veículo real (preço, marca, modelo, ano, combustível, código
      FIPE, mês de referência).
   2. Só se essa consulta der certo, `buildAnalysisResult(form, fipeData)`
      monta o resultado (nota, veredito, indicadores) usando o preço real
      como referência — nunca um valor inventado.
   3. Só então `completeAnalysis(session, access)` consome 1 das análises
      grátis. ADMIN não consome análises.
   4. Se a consulta falhar, nada disso acontece: nenhuma análise é
      descontada e o usuário volta pro formulário com um aviso.

   Indicadores de Manutenção e Revenda mostram "Dados insuficientes" porque
   ainda não existe uma fonte real para essas informações — nunca inventamos
   uma avaliação como se fosse dado real.

   AnalysisResult = {
     score: number (0-10),
     verdictTone: 'good' | 'warn' | 'bad',
     verdictLabel: string,
     referencePrice: number,
     diffPct: number,
     verdictText: string,
     indicators: [{ key, label, value, tone }],
     fipe: { brand, model, modelYear, fuel, codeFipe, referenceMonth }
   }

   ARQUITETURA DE ACESSO / MONETIZAÇÃO
   -------------------------------------------------------------------------
   O acesso é por QUANTIDADE DE ANÁLISES, não por tempo.

   - Usuário comum: 3 análises grátis.
   - Usuário PREMIUM: análises ilimitadas.
   - Usuário ADMIN: análises ilimitadas e não consome o contador.

   FONTE REAL DE VERDADE: o projeto Supabase "VALE".
   -------------------------------------------------------------------------
   - Autenticação por e-mail/senha via Supabase Auth.
   - Tabela `public.profiles`:
     id, email, used_analyses, is_premium, is_admin,
     created_at, updated_at.
   - RLS: o usuário só consegue LER a própria linha.
   - `is_admin` é configurado diretamente no Supabase.
   - ADMIN é apenas uma permissão de teste/administração do aplicativo.
   - `computeAccess(profile)` deriva o status a partir do perfil real.

   Status:
       ADMIN                    -> is_admin = true
       PREMIUM                  -> is_premium = true
       FREE_ANALYSES_REMAINING  -> ainda possui análises grátis
       USED_ANALYSES            -> gratuitas acabaram

   `canStartAnalysis()` é a função que decide se uma nova análise pode
   começar.

   `completeAnalysis()` é a função que consome uma análise grátis.
   Quando o usuário é ADMIN, ela não chama o RPC e não altera o contador.

   Pagamento:
   Abrir o checkout NÃO marca o usuário como PREMIUM.
   A confirmação automática via webhook da Cakto ainda não existe neste MVP.
   ========================================================================= */

// ---------------------------------------------------------------------------
// Configuração do Supabase
// ---------------------------------------------------------------------------
const SUPABASE_CONFIG = {
  URL: "https://yzfmchcrslqmsizfwzyr.supabase.co",
  ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6Zm1jaGNyc2xxbXNpemZ3enlyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxMzUwNzMsImV4cCI6MjEwMzcxMTA3M30.kDvii-A6AK_UTY_QEI8vH-AMwBa6S8N-lEvS9kt5Dys",
};

// ---------------------------------------------------------------------------
// Configuração de acesso / monetização
// ---------------------------------------------------------------------------
const ACCESS_CONFIG = {
  FREE_ANALYSES_LIMIT: 3,
  PRICE_LABEL: "R$ 39,99/mês",
  PLAN_NAME: "VALE? PRO",
  CHECKOUT_URL: "https://pay.cakto.com.br/34qt8g9_1073973",
};

const SESSION_CACHE_KEY = "vale:session-v1";

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------
function openCheckout() {
  window.open(ACCESS_CONFIG.CHECKOUT_URL, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Cache local de sessão
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Supabase Auth
// ---------------------------------------------------------------------------
function supaAuthHeaders(accessToken) {
  const headers = {
    "Content-Type": "application/json",
    apikey: SUPABASE_CONFIG.ANON_KEY,
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  return headers;
}

async function supaParseAuthError(res) {
  let data = {};

  try {
    data = await res.json();
  } catch (e) {
    // resposta sem corpo JSON
  }

  return new Error(
    data.error_description ||
      data.msg ||
      data.error ||
      "Não foi possível completar a solicitação."
  );
}

async function supaSignUp(name, email, password) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/signup`, {
    method: "POST",
    headers: supaAuthHeaders(),
    body: JSON.stringify({
      email,
      password,
      data: { name },
    }),
  });

  if (!res.ok) throw await supaParseAuthError(res);

  return res.json();
}

async function supaSignIn(email, password) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: supaAuthHeaders(),
      body: JSON.stringify({ email, password }),
    }
  );

  if (!res.ok) throw await supaParseAuthError(res);

  return res.json();
}

async function supaSendPasswordRecovery(email) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/auth/v1/recover`,
    {
      method: "POST",
      headers: supaAuthHeaders(),
      body: JSON.stringify({
        email,
        redirect_to: window.location.origin,
      }),
    }
  );

  if (!res.ok) throw await supaParseAuthError(res);

  return res.json();
}

async function supaUpdatePassword(accessToken, password) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/auth/v1/user`,
    {
      method: "PUT",
      headers: supaAuthHeaders(accessToken),
      body: JSON.stringify({ password }),
    }
  );

  if (!res.ok) throw await supaParseAuthError(res);

  return res.json();
}

async function supaRefreshSession(refreshToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=refresh_token`,
    {
      method: "POST",
      headers: supaAuthHeaders(),
      body: JSON.stringify({ refresh_token: refreshToken }),
    }
  );

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
    // best-effort
  }
}

function sessionFromAuthResponse(data) {
  const nowSec = Math.floor(Date.now() / 1000);

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: nowSec + (data.expires_in || 3600),
    user: {
      id: data.user && data.user.id,
      email: data.user && data.user.email,
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase REST — profiles + RPC
// ---------------------------------------------------------------------------
async function supaFetchProfile(accessToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/rest/v1/profiles?select=id,email,used_analyses,is_premium,is_admin`,
    {
      headers: supaAuthHeaders(accessToken),
    }
  );

  if (!res.ok) return null;

  const rows = await res.json();

  return rows[0] || null;
}

async function supaFetchProfileWithRetry(accessToken) {
  const first = await supaFetchProfile(accessToken);

  if (first) return first;

  await new Promise((resolve) => setTimeout(resolve, 500));

  return supaFetchProfile(accessToken);
}

async function supaIncrementUsedAnalyses(accessToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/rest/v1/rpc/increment_used_analyses`,
    {
      method: "POST",
      headers: supaAuthHeaders(accessToken),
      body: JSON.stringify({}),
    }
  );

  if (!res.ok) return null;

  return res.json();
}

// ---------------------------------------------------------------------------
// FIPE via Edge Function
// ---------------------------------------------------------------------------
async function callDynamicService(action, params, accessToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/functions/v1/dynamic-service`,
    {
      method: "POST",
      headers: supaAuthHeaders(accessToken),
      body: JSON.stringify({
        action,
        ...params,
      }),
    }
  );

  let json = null;

  try {
    json = await res.json();
  } catch (e) {
    // resposta sem corpo JSON
  }

  if (!res.ok || !json || json.success !== true) {
    const message =
      (json && json.error) ||
      `Falha ao consultar a FIPE (${action}).`;

    throw new Error(message);
  }

  return json.data;
}

async function fetchFipeBrands(accessToken) {
  return callDynamicService("brands", {}, accessToken);
}

async function fetchFipeModels(brandId, accessToken) {
  return callDynamicService("models", { brandId }, accessToken);
}

async function fetchFipeYears(brandId, modelId, accessToken) {
  return callDynamicService(
    "years",
    {
      brandId,
      modelId,
    },
    accessToken
  );
}

async function fetchFipeDetail(
  brandId,
  modelId,
  yearId,
  accessToken
) {
  return callDynamicService(
    "detail",
    {
      brandId,
      modelId,
      yearId,
    },
    accessToken
  );
}

// ---------------------------------------------------------------------------
// Controle de acesso
// ---------------------------------------------------------------------------

// Única função central que decide se uma nova análise pode começar.
function canStartAnalysis(access) {
  if (!access) return false;

  return (
    access.status === "ADMIN" ||
    access.status === "PREMIUM" ||
    access.status === "FREE_ANALYSES_REMAINING"
  );
}

// Registra uma análise concluída.
// ADMIN NÃO consome análise.
// PREMIUM também não consome análise.
// Usuário gratuito consome via RPC.
async function completeAnalysis(session, access) {
  if (!session) return null;

  // ADMIN tem análises ilimitadas e não consome o contador.
  if (access?.status === "ADMIN") {
    return null;
  }

  // PREMIUM também possui análises ilimitadas.
  if (access?.status === "PREMIUM") {
    return null;
  }

  try {
    return await supaIncrementUsedAnalyses(session.access_token);
  } catch (e) {
    console.error(
      "VALE?: falha ao registrar análise concluída.",
      e
    );

    return null;
  }
}

// Deriva o status de acesso a partir do perfil vindo do Supabase.
function computeAccess(profile) {
  if (!profile) return null;

  // ADMIN tem prioridade.
  if (profile.is_admin) {
    return {
      status: "ADMIN",
      remaining: null,
    };
  }

  if (profile.is_premium) {
    return {
      status: "PREMIUM",
      remaining: null,
    };
  }

  const used = profile.used_analyses || 0;

  const remaining = Math.max(
    0,
    ACCESS_CONFIG.FREE_ANALYSES_LIMIT - used
  );

  if (remaining <= 0) {
    return {
      status: "USED_ANALYSES",
      remaining: 0,
    };
  }

  return {
    status: "FREE_ANALYSES_REMAINING",
    remaining,
  };
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
  good: {
    fg: C.green,
    bg: C.greenDim,
  },
  warn: {
    fg: C.amber,
    bg: C.amberDim,
  },
  bad: {
    fg: C.red,
    bg: C.redDim,
  },
  neutral: {
    fg: C.muted,
    bg: C.surfaceInput,
  },
};

// ---------------------------------------------------------------------------
// Ícones
// ---------------------------------------------------------------------------
function Icon({
  size = 20,
  color = "currentColor",
  strokeWidth = 1.8,
  children,
  style,
}) {
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

const ChevronDownIcon = (p) => (
  <Icon {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Icon>
);

const CarIcon = (p) => (
  <Icon {...p}>
    <path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11" />
    <rect x="3" y="11" width="18" height="6" rx="2" />
    <circle
      cx="7.5"
      cy="17.3"
      r="1.6"
      fill={p.color || "currentColor"}
      stroke="none"
    />
    <circle
      cx="16.5"
      cy="17.3"
      r="1.6"
      fill={p.color || "currentColor"}
      stroke="none"
    />
  </Icon>
);

const StarIcon = (p) => (
  <svg
    width={p.size || 20}
    height={p.size || 20}
    viewBox="0 0 24 24"
  >
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
    <circle
      cx="16.5"
      cy="14"
      r="1.1"
      fill={p.color || "currentColor"}
      stroke="none"
    />
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
    <circle
      cx="12"
      cy="12"
      r="1.2"
      fill={p.color || "currentColor"}
      stroke="none"
    />
  </Icon>
);

const AlertTriangleIcon = (p) => (
  <Icon {...p}>
    <polygon points="12 3 22 20 2 20" />
    <line x1="12" y1="9" x2="12" y2="14" />
    <circle
      cx="12"
      cy="17"
      r="1"
      fill={p.color || "currentColor"}
      stroke="none"
    />
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
  <svg
    width={p.size || 20}
    height={p.size || 20}
    viewBox="0 0 24 24"
  >
    <polygon
      points="13,2 3,14 11,14 9,22 21,10 13,10"
      fill={p.color || "currentColor"}
    />
  </svg>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const digits = (s) => (s || "").replace(/\D/g, "");

const fmtThousands = (d) =>
  d ? Number(d).toLocaleString("pt-BR") : "";

const fmtBRL = (n) =>
  "R$ " +
  Math.round(n).toLocaleString("pt-BR", {
    maximumFractionDigits: 0,
  });

const CURRENT_YEAR = new Date().getFullYear();

function parseFipeCurrencyToNumber(value) {
  if (typeof value === "number") return value;

  const cleaned = String(value || "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");

  const n = Number(cleaned);

  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Resultado da análise
// ---------------------------------------------------------------------------
function buildAnalysisResult(form, fipeData) {
  const priceNum = Number(digits(form.price)) || 0;
  const kmNum = Number(digits(form.km)) || 0;

  const referencePrice = parseFipeCurrencyToNumber(
    fipeData.price
  );

  const yearNum =
    Number(fipeData.modelYear) ||
    Number(form.year) ||
    CURRENT_YEAR;

  const age = Math.max(CURRENT_YEAR - yearNum, 0);

  const diffPct =
    referencePrice > 0
      ? ((priceNum - referencePrice) / referencePrice) * 100
      : 0;

  let score = 7 - diffPct * 0.3;

  score = Math.max(0, Math.min(10, score));

  let verdictTone;
  let verdictLabel;

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
    verdictText = `O preço informado está ${Math.abs(
      diffPct
    ).toFixed(
      1
    )}% abaixo da referência FIPE. O veículo pode representar uma oportunidade — ainda assim, vale confirmar o estado geral do carro antes de fechar negócio.`;
  } else if (diffPct >= 5) {
    verdictText = `O preço informado está ${diffPct.toFixed(
      1
    )}% acima da referência FIPE. Vale negociar ou entender o que justifica esse valor antes de avançar.`;
  } else {
    verdictText =
      "O preço informado está próximo da referência FIPE — um valor dentro do esperado. A decisão pode depender mais do estado de conservação do que do preço em si.";
  }

  const precoTone =
    diffPct <= -5
      ? "good"
      : diffPct < 5
      ? "warn"
      : "bad";

  const precoLabel =
    diffPct <= -5
      ? "Bom"
      : diffPct < 5
      ? "Regular"
      : "Alto";

  const expectedKm = Math.max(age, 1) * 15000;

  const ratio =
    expectedKm > 0 ? kmNum / expectedKm : 0;

  let kmTone;
  let kmLabel;

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

    fipe: {
      brand: fipeData.brand,
      model: fipeData.model,
      modelYear: fipeData.modelYear,
      fuel: fipeData.fuel,
      codeFipe: fipeData.codeFipe,
      referenceMonth: fipeData.referenceMonth,
    },

    indicators: [
      {
        key: "preco",
        label: "Preço",
        value: precoLabel,
        tone: precoTone,
        Icon: WalletIcon,
      },
      {
        key: "manut",
        label: "Manutenção",
        value: manutLabel,
        tone: manutTone,
        Icon: GearIcon,
      },
      {
        key: "revenda",
        label: "Revenda",
        value: revendaLabel,
        tone: revendaTone,
        Icon: TrendUpIcon,
      },
      {
        key: "km",
        label: "Quilometragem",
        value: kmLabel,
        tone: kmTone,
        Icon: GaugeSmallIcon,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Componentes visuais
// ---------------------------------------------------------------------------
function ScoreGauge({ score, tone }) {
  const size = 200;
  const r = 82;
  const cx = size / 2;
  const cy = size / 2;

  const circ = 2 * Math.PI * r;

  const sweep = 0.75;

  const trackLen = circ * sweep;
  const gapLen = circ - trackLen;

  const progress =
    Math.max(0, Math.min(1, score / 10)) *
    trackLen;

  const color = TONE[tone].fg;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          transform: "rotate(135deg)",
        }}
      >
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
          style={{
            transition:
              "stroke-dasharray 900ms cubic-bezier(.2,.8,.2,1)",
            filter: `drop-shadow(0 0 10px ${color}55)`,
          }}
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
        <div
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 4,
          }}
        >
          <span
            style={{
              fontFamily:
                "'JetBrains Mono', monospace",
              fontSize: 44,
              fontWeight: 600,
              color: C.text,
              letterSpacing: -1,
            }}
          >
            {score.toFixed(1)}
          </span>

          <span
            style={{
              fontFamily:
                "'JetBrains Mono', monospace",
              fontSize: 15,
              color: C.muted,
            }}
          >
            /10
          </span>
        </div>

        <div
          style={{
            display: "flex",
            gap: 3,
            marginTop: 4,
          }}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <StarIcon
              key={i}
              size={12}
              color={
                i < Math.round(score / 2)
                  ? C.gold
                  : C.border
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function IndicatorChip({
  icon: IconComp,
  label,
  value,
  tone,
}) {
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
        <IconComp
          size={17}
          color={t.fg}
          strokeWidth={2}
        />
      </div>

      <div>
        <div
          style={{
            fontSize: 12,
            color: C.muted,
            marginBottom: 2,
          }}
        >
          {label}
        </div>

        <div
          style={{
            fontSize:
              value === "Dados insuficientes"
                ? 12.5
                : 14.5,
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
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
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

function TextField({
  value,
  onChange,
  placeholder,
  inputMode,
  maxLength,
  prefix,
  type = "text",
  autoComplete,
}) {
  const [focused, setFocused] =
    useState(false);

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
            fontFamily:
              "'JetBrains Mono', monospace",
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
          borderColor: focused
            ? C.gold
            : C.border,
          boxShadow: focused
            ? `0 0 0 3px ${C.gold}22`
            : "none",
          fontFamily:
            inputMode === "numeric"
              ? "'JetBrains Mono', monospace"
              : "'Inter', sans-serif",
          transition:
            "border-color 160ms, box-shadow 160ms",
        }}
      />
    </div>
  );
}

function SelectField({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  loading,
}) {
  const [focused, setFocused] =
    useState(false);

  const isEmpty = !value;

  return (
    <div style={{ position: "relative" }}>
      <select
        value={value}
        onChange={onChange}
        disabled={disabled}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputBase,
          appearance: "none",
          WebkitAppearance: "none",
          MozAppearance: "none",
          paddingRight: 40,
          color: isEmpty
            ? C.faint
            : C.text,
          borderColor: focused
            ? C.gold
            : C.border,
          boxShadow: focused
            ? `0 0 0 3px ${C.gold}22`
            : "none",
          opacity: disabled ? 0.6 : 1,
          cursor: disabled
            ? "not-allowed"
            : "pointer",
          transition:
            "border-color 160ms, box-shadow 160ms",
        }}
      >
        <option value="" disabled>
          {loading
            ? "Carregando…"
            : placeholder}
        </option>

        {options.map((opt) => (
          <option
            key={opt.value}
            value={opt.value}
          >
            {opt.label}
          </option>
        ))}
      </select>

      <ChevronDownIcon
        size={16}
        color={C.faint}
        style={{
          position: "absolute",
          right: 14,
          top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  icon,
}) {
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
        color: disabled
          ? C.faint
          : "#171006",
        fontFamily:
          "'Rajdhani', sans-serif",
        fontWeight: 700,
        fontSize: 16.5,
        letterSpacing: 1.1,
        textTransform: "uppercase",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        cursor: disabled
          ? "not-allowed"
          : "pointer",
        boxShadow: disabled
          ? "none"
          : `0 8px 24px -8px ${C.gold}88`,
        transition: "transform 120ms ease",
      }}
      onMouseDown={(e) =>
        !disabled &&
        (e.currentTarget.style.transform =
          "scale(0.98)")
      }
      onMouseUp={(e) =>
        (e.currentTarget.style.transform =
          "scale(1)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.transform =
          "scale(1)")
      }
    >
      {icon}
      {children}
    </button>
  );
}

function SecondaryButton({
  children,
  onClick,
  style,
}) {
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
        fontFamily:
          "'Rajdhani', sans-serif",
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

function BackHeader({
  onBack,
  title,
  right,
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 22,
      }}
    >
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
        <ChevronLeftIcon
          size={19}
          color={C.text}
        />
      </button>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flex: 1,
        }}
      >
        <span
          style={{
            fontFamily:
              "'Rajdhani', sans-serif",
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
      }}
    >
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
        <GaugeSmallIcon
          size={size * 0.58}
          color="#171006"
          strokeWidth={2.2}
        />
      </div>

      <span
        style={{
          fontFamily:
            "'Rajdhani', sans-serif",
          fontWeight: 700,
          fontSize: size * 0.62,
          color: C.text,
          letterSpacing: 0.5,
        }}
      >
        VALE
        <span style={{ color: C.gold }}>
          ?
        </span>
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
        fontFamily:
          "'Inter', sans-serif",
        padding: "10px 16px",
        borderRadius: 12,
        boxShadow:
          "0 10px 30px -10px rgba(0,0,0,0.6)",
        zIndex: 50,
        animation:
          "vale-toast-in 220ms ease",
        whiteSpace: "nowrap",
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badge de acesso
// ---------------------------------------------------------------------------
function AccessBadge({ access }) {
  if (!access) return null;

  // ADMIN
  if (access.status === "ADMIN") {
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
          fontFamily:
            "'Rajdhani', sans-serif",
        }}
      >
        <ZapIcon
          size={11}
          color={C.gold}
        />

        VALE? ADMIN
      </div>
    );
  }

  // PREMIUM
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
          fontFamily:
            "'Rajdhani', sans-serif",
        }}
      >
        <ZapIcon
          size={11}
          color={C.gold}
        />

        VALE? PRO
      </div>
    );
  }

  // GRATUITAS RESTANTES
  if (
    access.status ===
    "FREE_ANALYSES_REMAINING"
  ) {
    const label =
      access.remaining === 1
        ? "1 análise grátis restante"
        : `${access.remaining} análises grátis restantes`;

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
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: C.green,
          }}
        />

        {label}
      </div>
    );
  }

  // GRATUITAS ACABARAM
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
// Loading
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
          animation:
            "vale-spin 800ms linear infinite",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
function AuthScreen({
  onSignUp,
  onSignIn,
  onForgotPassword,
}) {
  const [mode, setMode] = useState("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [recoverySent, setRecoverySent] = useState(false);

  const isSignup = mode === "signup";
  const isForgot = mode === "forgot";

  const canSubmit =
    email.trim().length > 3 &&
    (isForgot || password.length >= 6) &&
    (!isSignup || name.trim().length > 0) &&
    !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setLoading(true);
    setError("");

    try {
      if (isForgot) {
        await onForgotPassword(email.trim());
        setRecoverySent(true);
      } else if (isSignup) {
        const result = await onSignUp(
          name.trim(),
          email.trim(),
          password
        );

        if (!result || !result.confirmed) {
          setAwaitingConfirmation(true);
        }
      } else {
        await onSignIn(email.trim(), password);
      }
    } catch (e) {
      setError(
        e.message ||
          "Não foi possível completar a solicitação."
      );
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

        <p
          style={{
            fontSize: 14,
            color: C.muted,
            margin: 0,
            maxWidth: 290,
            lineHeight: 1.6,
          }}
        >
          Enviamos um link de confirmação para{" "}
          <strong style={{ color: C.text }}>
            {email.trim()}
          </strong>
          . Confirme para poder entrar no VALE?.
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

  if (recoverySent) {
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
            maxWidth: 300,
            lineHeight: 1.3,
          }}
        >
          Confira seu e-mail
        </h1>

        <p
          style={{
            fontSize: 14,
            color: C.muted,
            margin: 0,
            maxWidth: 310,
            lineHeight: 1.6,
          }}
        >
          Se existir uma conta com{" "}
          <strong style={{ color: C.text }}>
            {email.trim()}
          </strong>
          , enviamos um link para criar uma nova senha.
          Abra o link neste dispositivo.
        </p>

        <GhostLink
          onClick={() => {
            setRecoverySent(false);
            setMode("login");
            setError("");
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
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: 20,
          }}
        >
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
            {isSignup
              ? "Crie sua conta grátis."
              : isForgot
              ? "Recupere sua senha."
              : "Bem-vindo de volta."}
          </h1>

          <p
            style={{
              fontSize: 14.5,
              color: C.muted,
              margin: 0,
              maxWidth: 310,
              lineHeight: 1.6,
            }}
          >
            {isSignup
              ? "Faça suas análises e descubra se o preço daquele carro realmente vale a pena."
              : isForgot
              ? "Digite seu e-mail e enviaremos um link para você criar uma nova senha."
              : "Entre para continuar suas análises de onde parou."}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
            marginTop: 6,
          }}
        >
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

          {!isForgot && (
            <Field label="Senha">
              <TextField
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Mínimo 6 caracteres"
                type="password"
                autoComplete={
                  isSignup ? "new-password" : "current-password"
                }
              />
            </Field>
          )}

          {error && (
            <p
              style={{
                fontSize: 12.5,
                color: C.red,
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {error}
            </p>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        <PrimaryButton
          onClick={handleSubmit}
          disabled={!canSubmit}
          icon={<ZapIcon size={17} color="#171006" />}
        >
          {loading
            ? "Um instante…"
            : isSignup
            ? "Criar conta"
            : isForgot
            ? "Enviar link"
            : "Entrar"}
        </PrimaryButton>

        {!isSignup && !isForgot && (
          <GhostLink
            onClick={() => {
              setMode("forgot");
              setError("");
              setPassword("");
            }}
          >
            Esqueci minha senha
          </GhostLink>
        )}

        <GhostLink
          onClick={() => {
            setMode(
              isForgot
                ? "login"
                : isSignup
                ? "login"
                : "signup"
            );
            setError("");
            setPassword("");
          }}
        >
          {isForgot
            ? "Voltar para o login"
            : isSignup
            ? "Já tem conta? Entrar"
            : "Não tem conta? Criar uma"}
        </GhostLink>
      </div>
    </div>
  );
}

function ResetPasswordScreen({ onUpdatePassword }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canSubmit =
    password.length >= 6 &&
    confirmation.length >= 6 &&
    password === confirmation &&
    !loading;

  const handleSubmit = async () => {
    if (!canSubmit) return;

    setLoading(true);
    setError("");

    try {
      await onUpdatePassword(password);
    } catch (e) {
      setError(
        e.message ||
          "Não foi possível atualizar sua senha."
      );
    } finally {
      setLoading(false);
    }
  };

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
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 22,
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            gap: 18,
          }}
        >
          <Logo size={40} />

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
            Crie uma nova senha.
          </h1>

          <p
            style={{
              fontSize: 14.5,
              color: C.muted,
              margin: 0,
              maxWidth: 310,
              lineHeight: 1.6,
            }}
          >
            Escolha uma senha com pelo menos 6 caracteres para
            voltar a acessar sua conta.
          </p>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <Field label="Nova senha">
            <TextField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              type="password"
              autoComplete="new-password"
            />
          </Field>

          <Field label="Confirmar nova senha">
            <TextField
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="Digite novamente"
              type="password"
              autoComplete="new-password"
            />
          </Field>

          {password.length >= 6 &&
            confirmation.length >= 6 &&
            password !== confirmation && (
              <p
                style={{
                  fontSize: 12.5,
                  color: C.red,
                  margin: 0,
                }}
              >
                As senhas não são iguais.
              </p>
            )}

          {error && (
            <p
              style={{
                fontSize: 12.5,
                color: C.red,
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              {error}
            </p>
          )}
        </div>
      </div>

      <PrimaryButton
        onClick={handleSubmit}
        disabled={!canSubmit}
        icon={<CheckIcon size={17} color="#171006" />}
      >
        {loading ? "Atualizando…" : "Salvar nova senha"}
      </PrimaryButton>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function HomeScreen({
  onStart,
  access,
  onLogout,
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "0 24px 28px",
        animation:
          "vale-fade-in 380ms ease",
      }}
    >
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          textAlign: "center",
          gap: 22,
        }}
      >
        <div
          style={{
            width: 84,
            height: 84,
            borderRadius: 24,
            background:
              `radial-gradient(circle at 30% 25%, #2a2210, ${C.surface})`,
            border: `1px solid ${C.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 4,
          }}
        >
          <GaugeSmallIcon
            size={40}
            color={C.gold}
            strokeWidth={1.6}
          />
        </div>

        <div>
          <h1
            style={{
              fontFamily:
                "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 52,
              letterSpacing: 1,
              margin: 0,
              color: C.text,
              lineHeight: 1,
            }}
          >
            VALE
            <span style={{ color: C.gold }}>
              ?
            </span>
          </h1>
        </div>

        <p
          style={{
            fontFamily:
              "'Rajdhani', sans-serif",
            fontWeight: 600,
            fontSize: 19,
            color: C.text,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.35,
          }}
        >
          Antes de comprar, descubra se
          vale a pena.
        </p>

        <p
          style={{
            fontSize: 14.5,
            color: C.muted,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.6,
          }}
        >
          Analise o preço de um carro
          usado e veja se o negócio parece
          realmente bom.
        </p>

        <AccessBadge access={access} />
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <PrimaryButton
          onClick={onStart}
          icon={
            <SearchIcon
              size={19}
              color="#171006"
              strokeWidth={2.2}
            />
          }
        >
          Analisar meu carro
        </PrimaryButton>

        <p
          style={{
            fontSize: 11.5,
            color: C.faint,
            textAlign: "center",
            margin: 0,
            lineHeight: 1.5,
          }}
        >
          Análise de referência — não
          substitui avaliação profissional.
        </p>

        <div style={{ textAlign: "center" }}>
          <GhostLink onClick={onLogout}>
            Sair
          </GhostLink>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------
function FormScreen({
  form,
  setForm,
  onSubmit,
  onBack,
  accessToken,
  externalError,
}) {
  const [brands, setBrands] =
    useState([]);

  const [models, setModels] =
    useState([]);

  const [years, setYears] =
    useState([]);

  const [loadingBrands, setLoadingBrands] =
    useState(false);

  const [loadingModels, setLoadingModels] =
    useState(false);

  const [loadingYears, setLoadingYears] =
    useState(false);

  const [loadError, setLoadError] =
    useState("");

  const [retryKey, setRetryKey] =
    useState(0);

  useEffect(() => {
    let cancelled = false;

    if (!accessToken) {
      setLoadError(
        "Sua sessão expirou. Volte e entre novamente."
      );
      return;
    }

    setLoadingBrands(true);
    setLoadError("");

    fetchFipeBrands(accessToken)
      .then((data) => {
        if (cancelled) return;

        setBrands(
          Array.isArray(data) ? data : []
        );
      })
      .catch(() => {
        if (cancelled) return;

        setLoadError(
          "Não foi possível carregar as marcas da FIPE agora. Tente novamente."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingBrands(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [accessToken, retryKey]);

  useEffect(() => {
    let cancelled = false;

    setModels([]);
    setYears([]);

    if (!form.brandId || !accessToken) {
      return;
    }

    setLoadingModels(true);
    setLoadError("");

    fetchFipeModels(
      form.brandId,
      accessToken
    )
      .then((data) => {
        if (cancelled) return;

        setModels(
          Array.isArray(data) ? data : []
        );
      })
      .catch(() => {
        if (cancelled) return;

        setLoadError(
          "Não foi possível carregar os modelos dessa marca agora. Tente novamente."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModels(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    form.brandId,
    accessToken,
    retryKey,
  ]);

  useEffect(() => {
    let cancelled = false;

    setYears([]);

    if (
      !form.brandId ||
      !form.modelId ||
      !accessToken
    ) {
      return;
    }

    setLoadingYears(true);
    setLoadError("");

    fetchFipeYears(
      form.brandId,
      form.modelId,
      accessToken
    )
      .then((data) => {
        if (cancelled) return;

        setYears(
          Array.isArray(data) ? data : []
        );
      })
      .catch(() => {
        if (cancelled) return;

        setLoadError(
          "Não foi possível carregar os anos desse modelo agora. Tente novamente."
        );
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingYears(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    form.brandId,
    form.modelId,
    accessToken,
    retryKey,
  ]);

  const handleSelectBrand = (e) => {
    const brandId = e.target.value;

    const selected = brands.find(
      (b) => b.code === brandId
    );

    setForm((f) => ({
      ...f,
      brandId,
      brand:
        (selected && selected.name) ||
        "",
      modelId: "",
      model: "",
      yearId: "",
      year: "",
    }));
  };

  const handleSelectModel = (e) => {
    const modelId = e.target.value;

    const selected = models.find(
      (m) => m.code === modelId
    );

    setForm((f) => ({
      ...f,
      modelId,
      model:
        (selected && selected.name) ||
        "",
      yearId: "",
      year: "",
    }));
  };

  const handleSelectYear = (e) => {
    const yearId = e.target.value;

    const selected = years.find(
      (y) => y.code === yearId
    );

    setForm((f) => ({
      ...f,
      yearId,
      year: selected
        ? `${selected.name}`.match(
            /\d{4}/
          )?.[0] || ""
        : "",
    }));
  };

  const canAnalyze =
    Boolean(form.brandId) &&
    Boolean(form.modelId) &&
    Boolean(form.yearId) &&
    digits(form.km).length > 0 &&
    digits(form.price).length > 0;

  const displayError =
    externalError || loadError;

  const handleRetry = () => {
    if (externalError) {
      onSubmit();
    } else {
      setRetryKey((k) => k + 1);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "0 24px 24px",
        animation:
          "vale-slide-in 320ms ease",
      }}
    >
      <BackHeader
        onBack={onBack}
        title="Dados do veículo"
      />

      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            gap: 12,
          }}
        >
          <div style={{ flex: 1.3 }}>
            <Field label="Marca">
              <SelectField
                value={form.brandId}
                onChange={
                  handleSelectBrand
                }
                options={brands.map(
                  (b) => ({
                    value: b.code,
                    label: b.name,
                  })
                )}
                placeholder={
                  loadError &&
                  brands.length === 0
                    ? "Indisponível"
                    : "Selecione a marca"
                }
                loading={loadingBrands}
                disabled={
                  loadingBrands ||
                  (brands.length === 0 &&
                    !loadingBrands)
                }
              />
            </Field>
          </div>

          <div style={{ flex: 1.7 }}>
            <Field label="Modelo">
              <SelectField
                value={form.modelId}
                onChange={
                  handleSelectModel
                }
                options={models.map(
                  (m) => ({
                    value: m.code,
                    label: m.name,
                  })
                )}
                placeholder={
                  !form.brandId
                    ? "Selecione a marca primeiro"
                    : "Selecione o modelo"
                }
                loading={loadingModels}
                disabled={
                  !form.brandId ||
                  loadingModels ||
                  (models.length === 0 &&
                    !loadingModels)
                }
              />
            </Field>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <Field label="Ano">
              <SelectField
                value={form.yearId}
                onChange={
                  handleSelectYear
                }
                options={years.map(
                  (y) => ({
                    value: y.code,
                    label: y.name,
                  })
                )}
                placeholder={
                  !form.modelId
                    ? "Selecione o modelo primeiro"
                    : "Selecione o ano"
                }
                loading={loadingYears}
                disabled={
                  !form.modelId ||
                  loadingYears ||
                  (years.length === 0 &&
                    !loadingYears)
                }
              />
            </Field>
          </div>

          <div style={{ flex: 1 }}>
            <Field label="Quilometragem">
              <TextField
                value={form.km}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    km: fmtThousands(
                      digits(
                        e.target.value
                      )
                    ),
                  }))
                }
                placeholder="45.000"
                inputMode="numeric"
              />
            </Field>
          </div>
        </div>

        <Field label="Preço anunciado">
          <TextField
            value={form.price}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                price: fmtThousands(
                  digits(
                    e.target.value
                  )
                ),
              }))
            }
            placeholder="62.000"
            inputMode="numeric"
            prefix="R$"
          />
        </Field>

        {displayError ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              margin: "-4px 2px 0",
            }}
          >
            <p
              style={{
                fontSize: 12.5,
                color: C.red,
                margin: 0,
                lineHeight: 1.5,
                flex: 1,
              }}
            >
              {displayError}
            </p>

            <GhostLink
              onClick={handleRetry}
            >
              Tentar novamente
            </GhostLink>
          </div>
        ) : (
          <p
            style={{
              fontSize: 11.5,
              color: C.faint,
              margin: "4px 2px 0",
              lineHeight: 1.5,
            }}
          >
            Marca, modelo e ano vêm
            direto da tabela FIPE.
          </p>
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <PrimaryButton
          onClick={onSubmit}
          disabled={!canAnalyze}
        >
          Analisar carro
        </PrimaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Analyzing
// ---------------------------------------------------------------------------
const ANALYZING_MESSAGES = [
  "Lendo os dados do veículo…",
  "Consultando a tabela FIPE…",
  "Calculando a nota…",
];

function AnalyzingScreen() {
  const [step, setStep] =
    useState(0);

  useEffect(() => {
    const stepTimer =
      setInterval(() => {
        setStep(
          (s) =>
            (s + 1) %
            ANALYZING_MESSAGES.length
        );
      }, 900);

    return () =>
      clearInterval(stepTimer);
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
      <div
        style={{
          position: "relative",
          width: 76,
          height: 76,
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: "50%",
            border: `3px solid ${C.border}`,
            borderTopColor: C.gold,
            animation:
              "vale-spin 900ms linear infinite",
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
          <GaugeSmallIcon
            size={28}
            color={C.gold}
            strokeWidth={1.6}
          />
        </div>
      </div>

      <span
        key={step}
        style={{
          fontFamily:
            "'Rajdhani', sans-serif",
          fontWeight: 600,
          fontSize: 16,
          color: C.muted,
          animation:
            "vale-fade-in 250ms ease",
        }}
      >
        {ANALYZING_MESSAGES[step]}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function Row({
  label,
  value,
  muted,
  valueColor,
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent:
          "space-between",
        alignItems: "center",
      }}
    >
      <span
        style={{
          fontSize: 13.5,
          color: C.muted,
        }}
      >
        {label}
      </span>

      <span
        style={{
          fontFamily:
            "'JetBrains Mono', monospace",
          fontSize: 15.5,
          fontWeight: 600,
          color:
            valueColor ||
            (muted ? C.muted : C.text),
        }}
      >
        {value}
      </span>
    </div>
  );
}

function ResultScreen({
  result,
  onBack,
  onRestart,
}) {
  const [toast, setToast] =
    useState("");

  const toastTimer =
    useRef(null);

  const showToast = (msg) => {
    setToast(msg);

    clearTimeout(
      toastTimer.current
    );

    toastTimer.current =
      setTimeout(
        () => setToast(""),
        2200
      );
  };

  useEffect(
    () =>
      () =>
        clearTimeout(
          toastTimer.current
        ),
    []
  );

  const handleShare = async () => {
    const text = `VALE?
${result.fipe.brand} ${result.fipe.model} · ${result.fipe.modelYear}
${result.score.toFixed(
      1
    )}/10 — ${result.verdictLabel}
${fmtBRL(result.priceNum)}
Analisado pelo VALE?`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Minha análise VALE?",
          text,
        });
      } else {
        await navigator.clipboard.writeText(
          text
        );

        showToast(
          "Análise copiada!"
        );
      }
    } catch (e) {
      // usuário cancelou
    }
  };

  const tone =
    TONE[result.verdictTone];

  const diffLabel = `${
    result.diffPct >= 0 ? "+" : ""
  }${result.diffPct.toFixed(1)}%`;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "0 24px 24px",
        position: "relative",
        animation:
          "vale-slide-in 320ms ease",
      }}
    >
      <BackHeader
        onBack={onBack}
        title="Resultado da análise"
      />

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          paddingBottom: 4,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
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
            <CarIcon
              size={20}
              color={C.gold}
            />
          </div>

          <div
            style={{
              fontFamily:
                "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 19,
              color: C.text,
            }}
          >
            {result.fipe.brand}{" "}
            {result.fipe.model}{" "}
            <span
              style={{ color: C.muted }}
            >
              · {result.fipe.modelYear}
            </span>
          </div>
        </div>

        <div
          style={{
            background:
              `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            border: `1px solid ${C.border}`,
            borderRadius: 22,
            padding: "26px 20px 22px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            animation:
              "vale-fade-in 420ms ease",
          }}
        >
          <ScoreGauge
            score={result.score}
            tone={result.verdictTone}
          />

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
              fontFamily:
                "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 15.5,
              letterSpacing: 1,
            }}
          >
            {result.verdictTone ===
            "bad" ? (
              <AlertTriangleIcon
                size={15}
                color={tone.fg}
                strokeWidth={2.2}
              />
            ) : (
              <CheckIcon
                size={15}
                color={tone.fg}
                strokeWidth={2.6}
              />
            )}

            {result.verdictLabel}
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
            gap: 12,
            animation:
              "vale-fade-in 460ms ease",
          }}
        >
          <Row
            label="Preço anunciado"
            value={fmtBRL(
              result.priceNum
            )}
          />

          <div
            style={{
              height: 1,
              background: C.border,
            }}
          />

          <Row
            label="Preço de referência"
            value={fmtBRL(
              result.referencePrice
            )}
            muted
          />

          <div
            style={{
              height: 1,
              background: C.border,
            }}
          />

          <Row
            label="Diferença"
            value={diffLabel}
            valueColor={
              result.diffPct <= -5
                ? C.green
                : result.diffPct >= 5
                ? C.red
                : C.amber
            }
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
              REFERÊNCIA FIPE
            </span>

            <span>
              FIPE •{" "}
              {result.fipe.referenceMonth}
            </span>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              "1fr 1fr",
            gap: 10,
            animation:
              "vale-fade-in 500ms ease",
          }}
        >
          {result.indicators.map(
            (ind) => (
              <IndicatorChip
                key={ind.key}
                icon={ind.Icon}
                label={ind.label}
                value={ind.value}
                tone={ind.tone}
              />
            )
          )}
        </div>

        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            animation:
              "vale-fade-in 540ms ease",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 10,
            }}
          >
            <BulbIcon
              size={17}
              color={C.gold}
              strokeWidth={1.8}
            />

            <span
              style={{
                fontFamily:
                  "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: 14.5,
                letterSpacing: 1,
                color: C.text,
                textTransform:
                  "uppercase",
              }}
            >
              Nosso veredito
            </span>
          </div>

          <p
            style={{
              fontSize: 14,
              color: C.muted,
              lineHeight: 1.65,
              margin: 0,
            }}
          >
            {result.verdictText}
          </p>
        </div>

        <div
          style={{
            background: C.surfaceRaised,
            border: `1px solid ${C.border}`,
            borderRadius: 18,
            padding: 18,
            animation:
              "vale-fade-in 580ms ease",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 12,
            }}
          >
            <AlertTriangleIcon
              size={16}
              color={C.amber}
              strokeWidth={2}
            />

            <span
              style={{
                fontFamily:
                  "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: 14.5,
                letterSpacing: 1,
                color: C.text,
                textTransform:
                  "uppercase",
              }}
            >
              Antes de comprar
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            {[
              "Faça avaliação mecânica",
              "Verifique histórico de manutenção",
              "Faça laudo cautelar",
              "Confira documentação",
              "Faça um test-drive",
            ].map((item) => (
              <div
                key={item}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
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
                  <CheckIcon
                    size={12}
                    color={C.green}
                    strokeWidth={2.8}
                  />
                </div>

                <span
                  style={{
                    fontSize: 13.8,
                    color: C.text,
                  }}
                >
                  {item}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            padding: "2px 4px",
          }}
        >
          <DocIcon
            size={14}
            color={C.faint}
            style={{
              marginTop: 2,
              flexShrink: 0,
            }}
          />

          <p
            style={{
              fontSize: 11.5,
              color: C.faint,
              lineHeight: 1.6,
              margin: 0,
            }}
          >
            O VALE? fornece uma análise
            de referência e não substitui
            uma avaliação profissional do
            veículo.
          </p>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          marginTop: 16,
        }}
      >
        <PrimaryButton
          onClick={handleShare}
          icon={
            <ShareIcon
              size={18}
              color="#171006"
              strokeWidth={2}
            />
          }
        >
          Compartilhar análise
        </PrimaryButton>

        <SecondaryButton
          onClick={onRestart}
        >
          Nova análise
        </SecondaryButton>
      </div>

      <Toast message={toast} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paywall
// ---------------------------------------------------------------------------
function PaywallScreen({
  onContinue,
  onDismiss,
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "0 24px 24px",
        animation:
          "vale-fade-in 380ms ease",
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
          <LockIcon
            size={28}
            color={C.gold}
            strokeWidth={1.7}
          />
        </div>

        <h1
          style={{
            fontFamily:
              "'Rajdhani', sans-serif",
            fontWeight: 700,
            fontSize: 24,
            color: C.text,
            margin: 0,
            maxWidth: 280,
            lineHeight: 1.3,
          }}
        >
          Suas 3 análises gratuitas
          terminaram
        </h1>

        <p
          style={{
            fontSize: 14,
            color: C.muted,
            margin: 0,
            maxWidth: 300,
            lineHeight: 1.65,
          }}
        >
          Você já experimentou o VALE?.
          Continue analisando carros e
          descubra se realmente vale a pena
          antes de comprar.
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
            justifyContent:
              "space-between",
          }}
        >
          <div
            style={{
              textAlign: "left",
            }}
          >
            <div
              style={{
                fontFamily:
                  "'Rajdhani', sans-serif",
                fontWeight: 700,
                fontSize: 16,
                color: C.gold,
              }}
            >
              {ACCESS_CONFIG.PLAN_NAME}
            </div>

            <div
              style={{
                fontSize: 12.5,
                color: C.muted,
                marginTop: 2,
              }}
            >
              Análises ilimitadas
            </div>
          </div>

          <div
            style={{
              fontFamily:
                "'JetBrains Mono', monospace",
              fontWeight: 600,
              fontSize: 17,
              color: C.text,
            }}
          >
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
          {[
            "Novas análises de veículos",
            "Análise de preço",
            "Comparação com preço de referência",
            "Indicadores do veículo",
            "Veredito antes da compra",
          ].map((b) => (
            <div
              key={b}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <div
                style={{
                  width: 18,
                  height: 18,
                  minWidth: 18,
                  borderRadius: 6,
                  background: C.greenDim,
                  display: "flex",
                  alignItems: "center",
                  justifyContent:
                    "center",
                }}
              >
                <CheckIcon
                  size={11}
                  color={C.green}
                  strokeWidth={2.8}
                />
              </div>

              <span
                style={{
                  fontSize: 13.5,
                  color: C.text,
                }}
              >
                {b}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "center",
          marginTop: 16,
        }}
      >
        <PrimaryButton
          onClick={onContinue}
          icon={
            <ZapIcon
              size={17}
              color="#171006"
            />
          }
        >
          Continuar com VALE? PRO
        </PrimaryButton>

        <SecondaryButton
          onClick={onDismiss}
          style={{
            border: "none",
          }}
        >
          Agora não
        </SecondaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Offer
// ---------------------------------------------------------------------------
const PRO_BENEFITS = [
  "Análises ilimitadas",
  "Comparação com preço de referência",
  "Nota de 0 a 10",
  "Indicadores da análise",
  "Veredito do VALE?",
  "Compartilhamento das análises",
];

function OfferScreen({
  onBack,
  onSubscribe,
}) {
  const demoMode =
    !ACCESS_CONFIG.CHECKOUT_URL;

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        padding: "0 24px 24px",
        animation:
          "vale-slide-in 320ms ease",
      }}
    >
      <BackHeader
        onBack={onBack}
        title="VALE? PRO"
      />

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          paddingBottom: 4,
        }}
      >
        <div
          style={{
            textAlign: "center",
            padding: "6px 4px 2px",
          }}
        >
          <h1
            style={{
              fontFamily:
                "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 24,
              color: C.text,
              margin: "0 0 10px",
              lineHeight: 1.3,
            }}
          >
            Continue descobrindo se vale
            a pena.
          </h1>

          <p
            style={{
              fontSize: 13.5,
              color: C.muted,
              margin: 0,
              lineHeight: 1.6,
            }}
          >
            Tenha acesso às análises do
            VALE? e tome decisões mais
            inteligentes antes de comprar
            seu próximo carro.
          </p>
        </div>

        <div
          style={{
            background:
              `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            border: `1px solid ${C.gold}44`,
            borderRadius: 20,
            padding: "20px 20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              color: C.gold,
              fontFamily:
                "'Rajdhani', sans-serif",
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: 0.5,
            }}
          >
            <ZapIcon
              size={15}
              color={C.gold}
            />

            {ACCESS_CONFIG.PLAN_NAME}
          </div>

          <div
            style={{
              fontFamily:
                "'JetBrains Mono', monospace",
              fontWeight: 600,
              fontSize: 32,
              color: C.text,
              marginTop: 8,
            }}
          >
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
          {PRO_BENEFITS.map(
            (b) => (
              <div
                key={b}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    minWidth: 20,
                    borderRadius: 7,
                    background:
                      C.greenDim,
                    display: "flex",
                    alignItems: "center",
                    justifyContent:
                      "center",
                  }}
                >
                  <CheckIcon
                    size={12}
                    color={C.green}
                    strokeWidth={2.8}
                  />
                </div>

                <span
                  style={{
                    fontSize: 14,
                    color: C.text,
                  }}
                >
                  {b}
                </span>
              </div>
            )
          )}
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
              fontFamily:
                "'JetBrains Mono', monospace",
            }}
          >
            CHECKOUT_URL não configurada —
            este botão ativa um modo de
            demonstração local para testar o
            fluxo.
          </div>
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: 16,
          alignItems: "center",
        }}
      >
        <PrimaryButton
          onClick={onSubscribe}
          icon={
            <ZapIcon
              size={17}
              color="#171006"
            />
          }
        >
          Assinar VALE? PRO
        </PrimaryButton>

        <p
          style={{
            fontSize: 11,
            color: C.faint,
            margin: 0,
            textAlign: "center",
          }}
        >
          Pagamento realizado através do
          checkout.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const emptyForm = {
  brand: "",
  brandId: "",
  model: "",
  modelId: "",
  year: "",
  yearId: "",
  km: "",
  price: "",
};

export default function App() {
  const [screen, setScreen] =
    useState("loading");

  const [form, setForm] =
    useState(emptyForm);

  const [analysisResult, setAnalysisResult] =
    useState(null);

  const [analysisError, setAnalysisError] =
    useState("");

  const [session, setSession] =
    useState(null);

  const [recoverySession, setRecoverySession] =
    useState(null);

  const [profile, setProfile] =
    useState(null);

  // -------------------------------------------------------------------------
  // Carrega sessão e perfil
  // -------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    (async () => {
      const hash = window.location.hash.replace(/^#/, "");
      const hashParams = new URLSearchParams(hash);

      if (hashParams.get("type") === "recovery") {
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        const expiresAt = Number(hashParams.get("expires_at"));

        if (accessToken) {
          const recovery = {
            access_token: accessToken,
            refresh_token: refreshToken || "",
            expires_at:
              Number.isFinite(expiresAt) && expiresAt > 0
                ? expiresAt
                : Math.floor(Date.now() / 1000) + 3600,
          };

          if (mounted) {
            setRecoverySession(recovery);
            setScreen("reset-password");
          }

          window.history.replaceState(
            {},
            document.title,
            window.location.pathname + window.location.search
          );

          return;
        }
      }

      const cached =
        await loadCachedSession();

      if (!cached) {
        if (mounted) {
          setScreen("auth");
        }

        return;
      }

      let activeSession = cached;

      const nowSec = Math.floor(
        Date.now() / 1000
      );

      if (
        !cached.expires_at ||
        cached.expires_at <=
          nowSec + 30
      ) {
        const refreshed =
          await supaRefreshSession(
            cached.refresh_token
          );

        if (!refreshed) {
          await clearCachedSession();

          if (mounted) {
            setScreen("auth");
          }

          return;
        }

        activeSession =
          sessionFromAuthResponse(
            refreshed
          );

        await saveCachedSession(
          activeSession
        );
      }

      const freshProfile =
        await supaFetchProfileWithRetry(
          activeSession.access_token
        );

      if (!mounted) return;

      if (!freshProfile) {
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

  // -------------------------------------------------------------------------
  // Status de acesso
  // -------------------------------------------------------------------------
  const access = useMemo(
    () => computeAccess(profile),
    [profile]
  );

  // -------------------------------------------------------------------------
  // Login / cadastro
  // -------------------------------------------------------------------------
  const establishSession = async (
    authData
  ) => {
    const newSession =
      sessionFromAuthResponse(
        authData
      );

    setSession(newSession);

    await saveCachedSession(
      newSession
    );

    const freshProfile =
      await supaFetchProfileWithRetry(
        newSession.access_token
      );

    setProfile(freshProfile);

    setScreen("home");
  };

  const handleSignUp = async (
    name,
    email,
    password
  ) => {
    const data = await supaSignUp(
      name,
      email,
      password
    );

    if (
      data &&
      data.access_token
    ) {
      await establishSession(data);

      return {
        confirmed: true,
      };
    }

    return {
      confirmed: false,
    };
  };

  const handleSignIn = async (
    email,
    password
  ) => {
    const data = await supaSignIn(
      email,
      password
    );

    await establishSession(data);
  };

  const handleForgotPassword = async (email) => {
    await supaSendPasswordRecovery(email);
  };

  const handleUpdatePassword = async (newPassword) => {
    if (!recoverySession?.access_token) {
      throw new Error(
        "O link de recuperação é inválido ou expirou. Solicite um novo link."
      );
    }

    await supaUpdatePassword(
      recoverySession.access_token,
      newPassword
    );

    await clearCachedSession();
    setRecoverySession(null);
    setSession(null);
    setProfile(null);
    setForm(emptyForm);
    setAnalysisResult(null);
    setAnalysisError("");
    setScreen("auth");
  };

  // -------------------------------------------------------------------------
  // Logout
  // -------------------------------------------------------------------------
  const handleLogout = async () => {
    if (session) {
      await supaSignOut(
        session.access_token
      );
    }

    await clearCachedSession();

    setSession(null);
    setProfile(null);
    setForm(emptyForm);
    setAnalysisResult(null);
    setAnalysisError("");
    setScreen("auth");
  };

  // -------------------------------------------------------------------------
  // Começar análise
  // -------------------------------------------------------------------------
  const requestAnalysis = () => {
    if (!canStartAnalysis(access)) {
      setScreen("paywall");
    } else {
      setScreen("form");
    }
  };

  // -------------------------------------------------------------------------
  // Enviar formulário / consultar FIPE
  // -------------------------------------------------------------------------
  const handleSubmitForm =
    async () => {
      setAnalysisError("");

      setScreen("analyzing");

      let fipeData;

      try {
        fipeData =
          await fetchFipeDetail(
            form.brandId,
            form.modelId,
            form.yearId,
            session &&
              session.access_token
          );
      } catch (e) {
        setAnalysisError(
          "Não foi possível consultar o preço na FIPE agora. Tente novamente em instantes."
        );

        setScreen("form");

        return;
      }

      // IMPORTANTE:
      // ADMIN não consome análise.
      // PREMIUM também não consome análise.
      // Apenas usuário gratuito consome via RPC.
      const updatedProfile =
        await completeAnalysis(
          session,
          access
        );

      if (updatedProfile) {
        setProfile(
          updatedProfile
        );
      }

      setAnalysisResult(
        buildAnalysisResult(
          form,
          fipeData
        )
      );

      setScreen("result");
    };

  // -------------------------------------------------------------------------
  // Nova análise
  // -------------------------------------------------------------------------
  const handleNewAnalysis = () => {
    if (!canStartAnalysis(access)) {
      setScreen("paywall");

      return;
    }

    setForm(emptyForm);
    setAnalysisResult(null);
    setAnalysisError("");
    setScreen("form");
  };

  // -------------------------------------------------------------------------
  // Assinatura
  // -------------------------------------------------------------------------
  const handleSubscribe = () => {
    openCheckout();
  };

  const showHeader =
    screen === "home";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        background:
          `radial-gradient(120% 60% at 50% -10%, #16130a 0%, ${C.bg} 55%)`,
        display: "flex",
        justifyContent: "center",
        fontFamily:
          "'Inter', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

        * { box-sizing: border-box; }

        input::placeholder {
          color: ${C.faint};
        }

        input:focus {
          outline: none;
        }

        button {
          font-family: inherit;
        }

        @keyframes vale-fade-in {
          from {
            opacity: 0;
            transform: translateY(6px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes vale-slide-in {
          from {
            opacity: 0;
            transform: translateX(10px);
          }

          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        @keyframes vale-toast-in {
          from {
            opacity: 0;
            transform: translate(-50%, 6px);
          }

          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }

        @keyframes vale-spin {
          from {
            transform: rotate(0deg);
          }

          to {
            transform: rotate(360deg);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          * {
            animation-duration: 0.01ms !important;
            transition-duration: 0.01ms !important;
          }
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
          <div
            style={{
              padding:
                "22px 24px 4px",
              display: "flex",
              justifyContent:
                "space-between",
              alignItems: "center",
            }}
          >
            <Logo />
          </div>
        )}

        {screen === "loading" && (
          <LoadingScreen />
        )}

        {screen === "auth" && (
          <AuthScreen
            onSignUp={handleSignUp}
            onSignIn={handleSignIn}
            onForgotPassword={
              handleForgotPassword
            }
          />
        )}

        {screen === "reset-password" && (
          <ResetPasswordScreen
            onUpdatePassword={
              handleUpdatePassword
            }
          />
        )}

        {screen === "home" && (
          <HomeScreen
            onStart={
              requestAnalysis
            }
            access={access}
            onLogout={
              handleLogout
            }
          />
        )}

        {screen === "form" && (
          <div
            style={{
              paddingTop: 22,
            }}
          >
            <FormScreen
              form={form}
              setForm={setForm}
              onSubmit={
                handleSubmitForm
              }
              onBack={() =>
                setScreen("home")
              }
              accessToken={
                session &&
                session.access_token
              }
              externalError={
                analysisError
              }
            />
          </div>
        )}

        {screen ===
          "analyzing" && (
          <AnalyzingScreen />
        )}

        {screen === "result" &&
          analysisResult && (
            <div
              style={{
                paddingTop: 22,
                display: "flex",
                flexDirection:
                  "column",
                flex: 1,
              }}
            >
              <ResultScreen
                result={
                  analysisResult
                }
                onBack={() =>
                  setScreen(
                    "form"
                  )
                }
                onRestart={
                  handleNewAnalysis
                }
              />
            </div>
          )}

        {screen === "paywall" && (
          <div
            style={{
              paddingTop: 22,
              display: "flex",
              flexDirection:
                "column",
              flex: 1,
            }}
          >
            <PaywallScreen
              onContinue={
                handleSubscribe
              }
              onDismiss={() =>
                setScreen(
                  "home"
                )
              }
            />
          </div>
        )}

        {screen === "offer" && (
          <div
            style={{
              paddingTop: 22,
              display: "flex",
              flexDirection:
                "column",
              flex: 1,
            }}
          >
            <OfferScreen
              onBack={() =>
                setScreen(
                  "paywall"
                )
              }
              onSubscribe={
                handleSubscribe
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
