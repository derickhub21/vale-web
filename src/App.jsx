import React, { useState, useMemo, useRef, useEffect } from "react";

/* =========================================================================
   VALE? — MVP
   "Antes de comprar, descubra se vale a pena."

   ARQUITETURA DE DADOS
   -------------------------------------------------------------------------
   O preço de referência vem 100% da FIPE de verdade, via Edge Function
   `dynamic-service` do Supabase (que por sua vez consulta a API da FIPE —
   a chave dela fica só no backend, nunca aqui). Fluxo, disparado pelo
   clique em "Analisar carro":

   1. `fetchFipeDetail(form.brandId, form.modelId, form.yearId, accessToken)`
      busca o veículo real (preço, marca, modelo, ano, combustível, código
      FIPE, mês de referência).
   2. Só se essa consulta for certa, `buildAnalysisResult(form, fipeData)`
      monta o resultado (nota, veredito, indicadores) usando o preço real
      como referência — nunca um valor inventado.
   3. Só então `completeAnalysis(session)` consome 1 das análises grátis.
   4. Se a consulta falhar, nada disso acontece: nenhuma análise é
      descontada e o usuário volta pro formulário com um aviso.

   Indicadores de Manutenção e Revenda mostram "Dados insuficientes" porque
   ainda não existe uma fonte real para essas informações — nunca inventamos
   uma avaliação como se fosse dada real.

   ResultadoDaAnálise = {
     pontuação: número (0-10),
     Tom do veredicto: 'bom' | 'aviso' | 'ruim'
     veredictoLabel: string,
     referencePrice: number, // fipeData.price, já convertido para número
     diffPct: número,
     textoVeredicto: string,
     indicadores: [{ chave, rótulo, valor, tom }],
     fipe: { marca, modelo, anoDoModelo, combustível, códigoFipe, mêsDeReferência }
   }

   ARQUITETURA DE ACESSO / MONETIZAÇÃO (leia antes de mexer em auth/paywall)
   -------------------------------------------------------------------------
   O acesso é por QUANTIDADE DE ANÁLISES, não por tempo. Todo usuário logado
   ganha ACCESS_CONFIG.FREE_ANALYSES_LIMIT análises gratuitas; cada uma só é
   contabilizada quando o resultado é efetivamente gerado (ver
   `completeAnalysis()`).

   FONTE REAL DE VERDADE: o projeto Supabase "VALE" (SUPABASE_CONFIG.URL).
   -------------------------------------------------------------------------
   - Autenticação por e-mail/senha através do próprio Supabase Auth (API REST,
     sem SDK — ver `supaSignUp` / `supaSignIn` / `supaRefreshSession`).
   - Tabela `public.profiles` (1 linha por usuário, criada automaticamente
     por um gatilho em `auth.users`): id, email, used_analyses, is_premium,
     criado_em, atualizado_em.
   - RLS: o usuário só consegue ler a própria linha. NÃO existe política de
     UPDATE/INSERT/DELETE para o cliente — ou seja, is_premium e
     used_analyses são IMPOSSÍVEIS de alteração diretamente pelo frontend,
     mesmo abrindo o DevTools e chamando a API na mão. A única escrita
     permitido ao usuário logado é a função `increment_used_analyses()`
     (RPC, SECURITY DEFINER), que só incrementa a própria linha e nunca
     mexe em is_premium.
   - `computeAccess(profile)` deriva o status da linha vinda do
     Supabase — nunca um contador visual "fake":

       FREE_ANALYSES_REMAINING -> used_analyses < ACCESS_CONFIG.FREE_ANALYSES_LIMIT
       USED_ANALYSES -> as gratuitas acabaram e is_premium é falso
       PREMIUM -> is_premium é verdadeiro

   `canStartAnalysis()` é a única função que decide se uma nova análise pode
   começar (usada tanto na Home quanto em "Nova análise"). `completeAnalysis()`
   é a única função que consome 1 análise gratuita (chamando o RPC acima), e
   só deve ser chamado depois que a tela de resultado for alcançada de
   verdade — se o usuário voltar, recarregar ou sair antes disso, nada é
   desconectado.

   `window.storage` (cache, autorização NUNCA): guardamos apenas o token de
   sessão (`access_token`/`refresh_token`) localmente, para não pedir login
   toda vez que o aplicativo abre. O status de acesso em si (used_analyses,
   is_premium) NUNCA é lido do cache — a cada abertura do app, ele é procurado
   de novo no Supabase com o token válido. Ou seja: alguém poderia até editar
   o cache local à mão, mas isso não muda o que o Supabase devolve.

   Pagamento: `ACCESS_CONFIG.CHECKOUT_URL` é o único ponto de configuração
   faça a finalização da compra. Hoje aponta para o checkout real da Cakto do VALE? PRÓ.
   Os dois pontos de entrada da assinatura — o CTA "Continuar com VALE? PRO"
   (tela de bloqueio) e o botão "Assinar VALE? PRO" (tela de oferta) —
   chame `openCheckout()`, que abre esse link real em uma nova aba.

   IMPORTANTE — clique no checkout ≠ pagamento confirmado:
   Abra o checkout NUNCA marca o usuário como PREMIUM. `is_premium` só pode
   ser alterado diretamente no banco (SQL) ou, futuramente, por um backend
   com a service_role key reagindo a um webhook real do Cakto — isso AINDA
   NÃO EXISTE neste MVP e não foi simulado. Veja a seção "REAL vs.
   DEMONSTRAÇÃO" logo abaixo de `ACCESS_CONFIG`.
   ============================================================================ */

// ---------------------------------------------------------------------------
// Configuração do Supabase (projeto "VALE") — fonte real de verdade do acesso
// ---------------------------------------------------------------------------
const SUPABASE_CONFIG = {
  URL: "https://yzfmchcrslqmsizfwzyr.supabase.co",
  // Chave anônima (legada, formato JWT) do projeto Supabase "VALE". É uma
  // chave PÚBLICA por natureza — protegida pelas políticas de RLS do banco,
  // por isso você pode viver no frontend com segurança.
  ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl6Zm1jaGNyc2xxbXNpemZ3enlyIiwicm9 sZSI6ImFub24iLCJpYXQiOjE3ODgxMzUwNzMsImV4cCI6MjEwMzcxMTA3M30.kDvii-A6AK_UTY_QEI8vH-AMwBa6S8N-lEvS9kt5Dys",
};

// ---------------------------------------------------------------------------
// Configuração de acesso / monetização (única fonte de verdade)
// ---------------------------------------------------------------------------
const ACCESS_CONFIG = {
  LIMITE DE ANÁLISES GRATUITAS: 3,
  ETIQUETA DE PREÇO: "R$ 39/mês",
  NOME_DO_PLANO: "VALE? PRO",
  // Check-out real do VALE? PRO na Cakto.
  CHECKOUT_URL: "https://pay.cakto.com.br/34qt8g9_1073973",
};

// Chave do cache de sessão LOCAL (só o token — nunca used_analyses/is_premium).
const SESSION_CACHE_KEY = "vale:session-v1";

// ---------------------------------------------------------------------------
// REAL vs. DEMONSTRAÇÃO — leia antes de mexer na monetização
// ---------------------------------------------------------------------------
// REAL (já em produção):
// - Cadastro (nome + e-mail + senha) e login (e-mail + senha) via Supabase
// Autenticação (projeto "VALE"). O nome vai para auth.users.user_metadata via
// `data` sem inscrição — nenhuma coluna nova em public.profiles.
// - used_analyses e is_premium vivem em public.profiles no Supabase, com
// RLS que só permite ao usuário LER a própria linha — sem escrita
// Direta é possível pelo frontend. O único jeito de consumir uma
// análise grátis é a função increment_used_analyses() (RPC), que só
// mexe na própria linha do usuário autenticado e nunca toca is_premium.
// - ACCESS_CONFIG.CHECKOUT_URL aponta para o checkout real do Cakto.
// openCheckout() abre esse link real. Isso NUNCA marca o usuário como
// PREMIUM sozinho.
//
// AINDA NÃO IMPLEMENTADO (depende de webhook/backend — próxima etapa):
// - A confirmação automática de que um pagamento na Cakto foi aprovado.
// Hoje, se alguém concordar, marcar is_premium = true precisa ser feito
// manualmente no Supabase (Editor SQL: `update public.profiles set
// is_premium = true where email = '...'`), porque não existe política de
// ATUALIZAÇÃO para o cliente e nenhum webhook ainda está conectado. Quando o
// webhook do Cakto para implementação, ele deverá rodar num backend com a
// service_role key (nunca no frontend) e fazer exatamente esse update.
//
// DEMONSTRAÇÃO: não existe mais nenhum modo de demonstração local. Como
// Supabase conectada, is_premium e used_analyses só mudam de verdade no
// banco — não há mais atalho de frontend para simular isso.
// ---------------------------------------------------------------------------
função abrirCheckout() {
  janela.abrir(ACCESS_CONFIG.CHECKOUT_URL, "_blank", "noopener,noreferrer");
}

// --------------------------- Cache de sessão local --------------------------
// Guarda SÓ o token (access_token/refresh_token) — nunca used_analyses nem
//é_premium. Serve para não pedir login de novo a cada abertura do app; um
// autorização em si é sempre revalidada buscando o perfil no Supabase.
função assíncrona carregarSessãoEmCache() {
  tentar {
    const res = await window.storage.get(SESSION_CACHE_KEY, false);
    Se (res && res.value) retorne JSON.parse(res.value);
    retornar nulo;
  } catch (e) {
    retornar nulo;
  }
}

função assíncrona salvarSessãoEmCache(sessão) {
  tentar {
    await window.storage.set(SESSION_CACHE_KEY, JSON.stringify(session), false);
  } catch (e) {
    console.error("VALE?: não foi possível salvar sessão localmente.", e);
  }
}

função assíncrona limparSessãoEmCache() {
  tentar {
    aguarde window.storage.delete(SESSION_CACHE_KEY, false);
  } catch (e) {
    // nada salvo ainda — tudo bem
  }
}

// ------------------------ Autenticação Supabase (REST, sem SDK) ---------------------
função supaAuthHeaders(accessToken) {
  const headers = { "Content-Type": "application/json", apikey: SUPABASE_CONFIG.ANON_KEY };
  se (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  retornar cabeçalhos;
}

função assíncrona supaParseAuthError(res) {
  seja data = {};
  tentar {
    dados = aguarde res.json();
  } catch (e) {
    // resposta sem corpo JSON
  }
  return new Error(data.error_description || data.msg || data.error || "Não foi possível completar a solicitação.");
}

função assíncrona supaSignUp(nome, e-mail, senha) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/signup`, {
    método: "POST",
    cabeçalhos: supaAuthHeaders(),
    // "name" vai em `data`, que o GoTrue guarda como user_metadata em
    // auth.users — não exige nenhuma coluna nova em public.profiles.
    corpo: JSON.stringify({ email, senha, dados: { nome } }),
  });
  se (!res.ok) lançar await supaParseAuthError(res);
  retornar res.json(); // { access_token?, refresh_token?, expires_in?, user } — sem tokens você precisa confirmar e-mail
}

função assíncrona supaSignIn(email, senha) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=password`, {
    método: "POST",
    cabeçalhos: supaAuthHeaders(),
    corpo: JSON.stringify({ email, senha }),
  });
  se (!res.ok) lançar await supaParseAuthError(res);
  return res.json(); // { access_token, refresh_token, expires_in, user }
}

função assíncrona supaRefreshSession(refreshToken) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/token?grant_type=refresh_token`, {
    método: "POST",
    cabeçalhos: supaAuthHeaders(),
    corpo: JSON.stringify({ refresh_token: refreshToken }),
  });
  se (!res.ok) retorne nulo;
  retornar res.json();
}

função assíncrona supaSignOut(accessToken) {
  tentar {
    await fetch(`${SUPABASE_CONFIG.URL}/auth/v1/logout`, {
      método: "POST",
      cabeçalhos: supaAuthHeaders(accessToken),
    });
  } catch (e) {
    // best-effort — o cache local é limpo de qualquer forma
  }
}

função sessionFromAuthResponse(dados) {
  const nowSec = Math.floor(Date.now() / 1000);
  retornar {
    token_de_acesso: data.token_de_acesso,
    refresh_token: data.refresh_token,
    expira_em: agoraSeg + (dados.expira_em || 3600),
    usuário: { id: data.user && data.user.id, email: data.user && data.user.email },
  };
}

// -------------------- Supabase REST (perfis de tabela + RPC) -----------------
função assíncrona supaFetchProfile(accessToken) {
  const res = await fetch(
    `${SUPABASE_CONFIG.URL}/rest/v1/profiles?select=id,email,used_analyses,is_premium`,
    { headers: supaAuthHeaders(accessToken) }
  );
  se (!res.ok) retorne nulo;
  const rows = await res.json();
  retornar linhas[0] || nulo;
}

// O gatilho que cria a linha em public.profiles roda na mesma transação do
// cadastro, então normalmente já está pronto quando chegamos aqui — mas em
// caso de uma instabilidade momentânea de rede/replicação, tentamos mais
// uma vez antes de desistir, em vez de desistir do usuário para a tela de
// logon de login após ele ter terminado de entrar.
função assíncrona supaFetchProfileWithRetry(accessToken) {
  const first = await supaFetchProfile(accessToken);
  se (primeiro) retornar primeiro;
  await new Promise((resolve) => setTimeout(resolve, 500));
  retornar supaFetchProfile(accessToken);
}

função assíncrona supaIncrementUsedAnalyses(accessToken) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/rest/v1/rpc/increment_used_analyses`, {
    método: "POST",
    cabeçalhos: supaAuthHeaders(accessToken),
    corpo: JSON.stringify({}),
  });
  se (!res.ok) retorne nulo;
  retornar res.json(); // linha atualizada de public.profiles
}

//-------------------- FIPE via Edge Function (serviço dinâmico) -------------
// A Edge Function `dynamic-service` já foi publicada no projeto Supabase e
// faz a ponte com a API da FIPE — a chave da FIPE fica só no backend
// (Deno.env), nunca aqui no frontend. Ação aceita: “marcas” | "modelos" |
// "anos" | "detail", sempre por POST, sempre retornando dado real (sem
// zombar). A resposta de sucesso vem como {sucesso: verdadeiro, dados}; erro vem
// como { erro, detalhes? }.
// Observação: esta chamada precisa sair de um navegador de verdade — o
// sandbox do Claude Artifact bloqueado por CSP qualquer busca para
// supabase.co (mesmo problema que já temos com o cadastro/login). Por
// isso foi validado no projeto web (vale-web/src/App.jsx), não aqui.
função assíncrona callDynamicService(ação, parâmetros, tokenDeAcesso) {
  const res = await fetch(`${SUPABASE_CONFIG.URL}/functions/v1/dynamic-service`, {
    método: "POST",
    cabeçalhos: supaAuthHeaders(accessToken),
    corpo: JSON.stringify({ ação, ...parâmetros }),
  });

  let json = null;
  tentar {
    json = aguarde res.json();
  } catch (e) {
    // resposta sem corpo JSON
  }

  se (!res.ok || !json || json.success !== true) {
    mensagem const = (json && json.error) || `Falha ao consultar a FIPE (${action}).`;
    lançar novo Erro(mensagem);
  }

  retornar json.dados; // payload real devolução pela FIPE
}

função assíncrona buscarFipeBrands(accessToken) {
  retornar callDynamicService("brands", {}, accessToken);
}

função assíncrona buscarModelosFipe(brandId, accessToken) {
  retornar callDynamicService("models", { brandId }, accessToken);
}

função assíncrona buscarAnosFipe(brandId, modelId, accessToken) {
  retornar callDynamicService("anos", { brandId, modelId }, accessToken);
}

// Ação já validada com sucesso em produção: devolver o preço FIPE real do
// veículo (brandId + modelId + yearId), sem placa e sem nenhum dado simulado.
função assíncrona buscarDetalheFipe(brandId, modelId, yearId, accessToken) {
  retornar callDynamicService("detail", { brandId, modelId, yearId }, accessToken);
}

// A API v2 da FIPE devolve cada ano como { code: "2021-1", name: "2021 Gasolina" }
// (código = ano-combustível). Extraímos só o ano numérico para manter
// compatibilidade com o restante do formulário/análise, que já trabalha com
// um ano de 4 dígitos.
function parseFipeYearNumber(item) {
  const source = `${(item && item.name) || ""} ${(item && item.code) || ""}`;
  const match = source.match(/\d{4}/);
  retornar correspondência ? correspondência[0] : "";
}

// Única função central que decide se uma nova análise pode começar.
função podeIniciarAnálise(acesso) {
  se (!acesso) retorne falso;
  retornar access.status === "PREMIUM" || access.status === "FREE_ANALYSES_REMAINING";
}

// Única função central que registra 1 análise concluída. Só devo ser
// chamada depois que a consulta FIPE já respondeu com sucesso (ver
// `handleSubmitForm` no componente App). Consome o RPC do Supabase —
// nunca faz conta local. Se a chamada falhar (ex: sem internet), retorna
// null e o app simplesmente não atualiza o contador local nessa hora.
função assíncrona completeAnalysis(session) {
  se (!sessão) retorne nulo;
  tentar {
    retornar await supaIncrementUsedAnalyses(session.access_token);
  } catch (e) {
    console.error("VALE?: falha ao registrador análise concluída.", e);
    retornar nulo;
  }
}

// Deriva o status de acesso a partir do perfil vindo do Supabase.
função computeAccess(profile) {
  se (!profile) retornar nulo;
  se (profile.is_premium) retorne { status: "PREMIUM", remaining: null };

  const usado = profile.used_analyses || 0;
  const remaining = Math.max(0, ACCESS_CONFIG.FREE_ANALYSES_LIMIT - usado);

  se (restante <= 0) retorne { status: "USED_ANALYSES", restante: 0 };
  retornar { status: "FREE_ANALYSES_REMAINING", restante };
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------
const C = {
  fundo: "#07080A",
  superfície: "#12151A",
  surfaceRaised: "#181C22",
  surfaceInput: "#0D0F13",
  borda: "#232830",
  borderStrong: "#323944",
  texto: "#F3F5F7",
  silenciado: "#8B92A0",
  fraco: "#565C66",
  ouro: "#E8B94A",
  goldDim: "#8A6A2A",
  verde: "#3ED598",
  greenDim: "#173327",
  vermelho: "#FF5C5C",
  redDim: "#331A1A",
  âmbar: "#FFB84D",
  âmbarDim: "#332510",
};

const TOM = {
  bom: { fg: C.verde, bg: C.verdeDim },
  aviso: { fg: C.amber, bg: C.amberDim },
  ruim: {fg: C.red, bg: C.redDim },
  neutro: { fg: C.muted, bg: C.surfaceInput },
};

// ---------------------------------------------------------------------------
// Ícones (formas simples e seguras, estilo linha, sem depender de libs)
// ---------------------------------------------------------------------------
function Icon({ size = 20, color = "currentColor", strokeWidth = 1.8, children, style }) {
  retornar (
    <svg
      largura={tamanho}
      altura={tamanho}
      viewBox="0 0 24 24"
      preencher="nenhum"
      traço={cor}
      larguraDoTraço={larguraDoTraço}
      strokeLinecap="round"
      strokeLinejoin="round"
      estilo={estilo}
    >
      {crianças}
    </svg>
  );
}

const SearchIcon = (p) => (
  <Ícone {...p}>
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.2" y2="16.2" />
  </Ícone>
);
const ChevronLeftIcon = (p) => (
  <Ícone {...p}>
    <polyline points="15 18 9 12 15 6" />
  </Ícone>
);
const ChevronDownIcon = (p) => (
  <Ícone {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Ícone>
);
const CarIcon = (p) => (
  <Ícone {...p}>
    <path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11" />
    <rect x="3" y="11" width="18" height="6" rx="2" />
    <circle cx="7.5" cy="17.3" r="1.6" fill={p.color || "currentColor"} stroke="none" />
    <circle cx="16.5" cy="17.3" r="1.6" fill={p.color || "currentColor"} stroke="none" />
  </Ícone>
);
const StarIcon = (p) => (
  <svg width={p.size || 20} height={p.size || 20} viewBox="0 0 24 24">
    <polígono
      pontos="12,2 14,9,8,6 22,9,3 16,5,14 18,2,21 12,17,3 5,8,21 7,5,14 2,9,3 9,1,8,6"
      preencher={p.cor || "corAtual"}
    />
  </svg>
);
const WalletIcon = (p) => (
  <Ícone {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2.2" />
    <path d="M3 10h18" />
    <circle cx="16.5" cy="14" r="1.1" fill={p.color || "currentColor"} stroke="none" />
  </Ícone>
);
const GearIcon = (p) => (
  <Ícone {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <caminho d = "M12 3,5v2,4M12 18,1v2,4M20,5 12h-2,4M5,9 ​​12H3,5M17,8 6,2l-1,7 1,7M7,9 16,1l-1,7 1,7M17,8 17,8l-1,7-1,7M7,9 7,9 6,2 6,2"/>
  </Ícone>
);
const TrendUpIcon = (p) => (
  <Ícone {...p}>
    <polyline points="2 17 9 10 13 14 22 5" />
    <polyline points="16 5 22 5 22 11" />
  </Ícone>
);
const GaugeSmallIcon = (p) => (
  <Ícone {...p}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="12" x2="16" y2="8" />
    <circle cx="12" cy="12" r="1.2" fill={p.color || "currentColor"} stroke="none" />
  </Ícone>
);
const AlertTriangleIcon = (p) => (
  <Ícone {...p}>
    <polygon points="12 3 22 20 2 20" />
    <line x1="12" y1="9" x2="12" y2="14" />
    <circle cx="12" cy="17" r="1" fill={p.color || "currentColor"} stroke="none" />
  </Ícone>
);
const CheckIcon = (p) => (
  <Ícone {...p}>
    <polyline points="20 6 9 17 4 12" />
  </Ícone>
);
const BulbIcon = (p) => (
  <Ícone {...p}>
    <circle cx="12" cy="10" r="5.2" />
    <path d="M9.6 19h4.8" />
    <path d="M10.2 21.5h3.6" />
    <line x1="12" y1="4.8" x2="12" y2="4.8" />
  </Ícone>
);
const ShareIcon = (p) => (
  <Ícone {...p}>
    <circle cx="18" cy="5" r="2.4" />
    <circle cx="6" cy="12" r="2.4" />
    <circle cx="18" cy="19" r="2.4" />
    <line x1="8.2" y1="10.7" x2="15.8" y2="6.5" />
    <line x1="8.2" y1="13.3" x2="15.8" y2="17.5" />
  </Ícone>
);
const DocIcon = (p) => (
  <Ícone {...p}>
    <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
    <line x1="8" y1="12" x2="16" y2="12" />
    <line x1="8" y1="16" x2="13" y2="16" />
  </Ícone>
);
const LockIcon = (p) => (
  <Ícone {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2.2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </Ícone>
);
const ZapIcon = (p) => (
  <svg width={p.size || 20} height={p.size || 20} viewBox="0 0 24 24">
    <polygon points="13,2 3,14 11,14 9,22 21,10 13,10" fill={p.color || "currentColor"} />
  </svg>
);

// ---------------------------------------------------------------------------
// Ajudantes
// ---------------------------------------------------------------------------
const dígitos = (s) => (s || "").replace(/\D/g, "");
const fmtThousands = (d) => (d ? Number(d).toLocaleString("pt-BR") : "");
const fmtBRL = (n) =>
  "R$ " + Math.round(n).toLocaleString("pt-BR", { maximumFractionDigits: 0 });

const ANO_ATUAL = new Date().getFullYear();

// A FIPE devolve o preço como texto formatado ("R$ 4.878,00") — convertemos
// para número pra poder calcular a diferença percentual e a nota.
função parseFipeCurrencyToNumber(valor) {
  Se (tipo de valor === "número") retornar valor;
  const cleaned = String(valor || "")
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .substituir(",", ".");
  const n = Número(limpo);
  retornar Number.isFinite(n) ? n : 0;
}

// Monta o resultado da análise a partir do que o usuário digitou (km, preço
// anunciado) e do veículo real com devolução pela FIPE (fipeData). O preço de
// referência é sempre `fipeData.price` — nunca um valor inventado.
função construirResultadoDaAnálise(formulário, dadosFipe) {
  const priceNum = Number(digits(form.price)) || 0;
  const kmNum = Number(digits(form.km)) || 0;
  const referencePrice = parseFipeCurrencyToNumber(fipeData.price);
  const yearNum = Number(fipeData.modelYear) || Number(form.year) || CURRENT_YEAR;
  const idade = Math.max(ANO_ATUAL - anoNum, 0);

  const diffPct = referencePrice > 0 ? ((priceNum - referencePrice) / referencePrice) * 100 : 0;

  seja score = 7 - diffPct * 0.3;
  pontuação = Math.max(0, Math.min(10, pontuação));

  deixe verdictTone, verdictLabel;
  se (pontuação >= 7,5) {
    verdictTone = "bom";
    verdictLabel = "BOM NEGÓCIO";
  } senão se (pontuação >= 5,5) {
    verdictTone = "aviso";
    verdictLabel = "NEGÓCIO OK";
  } outro {
    verdictTone = "ruim";
    verdictLabel = "ATENÇÃO AO PREÇO";
  }

  seja verdictText;
  se (diffPct <= -5) {
    verdictText = `O preço informado é ${Math.abs(diffPct).toFixed(
      1
    )}% abaixo da referência FIPE. O veículo pode representar uma oportunidade — ainda assim, vale confirmar o estado geral do carro antes de fechar negócio.`;
  } senão se (diffPct >= 5) {
    verdictText = `O preço informado é ${diffPct.toFixed(
      1
    )}% acima da referência FIPE. Vale negociar ou entender o que justifica esse valor antes de avançar.`;
  } outro {
    verdictText = `O preço informado está próximo da referência FIPE — um valor dentro do esperado. A decisão pode depender mais do estado de conservação do que do preço em si.`;
  }

  // Preço — cálculo a partir do valor informado vs. referência FIPE real
  const precoTone = diffPct <= -5 ? "bom" : diffPct < 5 ? "aviso" : "ruim";
  const precoLabel = diffPct <= -5 ? "Bom" : difPct < 5 ? "Regular": "Alto";

  // Quilometragem — calculado a partir da idade do veículo vs. km informado
  const expectedKm = Math.max(idade, 1) * 15000;
  const ratio = expectedKm > 0 ? kmNum / expectedKm : 0;
  seja kmTone, kmLabel;
  se (razão > 1,25) {
    kmTone = "ruim";
    kmLabel = "Alta";
  } senão se (razão > 0,9) {
    kmTone = "aviso";
    kmLabel = "Atenção";
  } outro {
    kmTone = "bom";
    kmLabel = "Baixa";
  }

  // Manutenção e Revenda: ainda não existe fonte de dados reais para isso.
  // Ao inventar uma avaliação, mostramos claramente que faltam dados.
  const manutTone = "neutro";
  const manutLabel = "Dados insuficientes";
  const revendaTone = "neutro";
  const revendaLabel = "Dados insuficientes";

  retornar {
    pontuação,
    veredictoTom,
    veredicto,
    preço de referência,
    diferençaPct,
    textoVeredicto,
    Número do preço,
    kmNum,
    anoNúmero,
    fipe: {
      marca: fipeData.brand,
      modelo: fipeData.model,
      anomodelo: fipeData.modelYear,
      combustível: dadosFipe.combustível,
      codeFipe: fipeData.codeFipe,
      mêsDeReferência: fipeData.mêsDeReferência,
    },
    indicadores: [
      { key: "preco", label: "Preço", valor: precoLabel, tom: precoTone, Icon: WalletIcon },
      { key: "manut", label: "Manutenção", valor: manutLabel, tom: manutTone, Icon: GearIcon },
      { key: "revenda", label: "Revenda", value: revendaLabel, tone: revendaTone, Icon: TrendUpIcon },
      { chave: "km", rótulo: "Quilometragem", valor: kmLabel, tom: kmTone, ícone: GaugeSmallIcon },
    ],
  };
}

// ---------------------------------------------------------------------------
// Componentes compartilhados
// ---------------------------------------------------------------------------
função ScoreGauge({ pontuação, tom }) {
  tamanho constante = 200;
  const r = 82;
  const cx = tamanho / 2;
  const cy = tamanho / 2;
  const circ = 2 * Math.PI * r;
  varredura constante = 0,75; //270 graus
  const trackLen = circ * sweep;
  const gapLen = circ - trackLen;
  const progresso = Math.max(0, Math.min(1, pontuação / 10)) * comprimentoDaPista;
  const cor = TOM[tom].fg;

  retornar (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(135deg)" }}>
        <circle
          cx={cx}
          cy={cy}
          r={r}
          preencher="nenhum"
          traço={C.borda}
          larguraDoTraço="10"
          strokeLinecap="round"
          acidente vascular cerebralDasharray={`${trackLen} ${gapLen}`}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r}
          preencher="nenhum"
          traço={cor}
          larguraDoTraço="10"
          strokeLinecap="round"
          strokeDasharray={`${progresso} ${circ - progresso}`}
          style={{ transition: "stroke-dasharray 900ms cubic-bezier(.2,.8,.2,1)", filter: `drop-shadow(0 0 10px ${color}55)` }}
        />
      </svg>
      <div
        estilo={{
          posição: "absoluta",
          inserção: 0,
          exibir: "flex",
          flexDirection: "coluna",
          alignItems: "center",
          justifyContent: "centro",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span
            estilo={{
              fontFamily: "'JetBrains Mono', monospace",
              Tamanho da fonte: 44,
              Peso da fonte: 600,
              cor: C.texto,
              Espaçamento entre letras: -1,
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

função IndicatorChip({ ícone: IconComp, rótulo, valor, tom }) {
  const t = TOM[tom];
  retornar (
    <div
      estilo={{
        fundo: C.superfícieRaised,
        borda: `1px sólida ${C.border}`,
        borderRadius: 16,
        preenchimento: "14px 14px",
        exibir: "flex",
        flexDirection: "coluna",
        intervalo: 10,
      }}
    >
      <div
        estilo={{
          largura: 32,
          altura: 32,
          borderRadius: 10,
          fundo: t.bg,
          exibir: "flex",
          alignItems: "center",
          justifyContent: "centro",
        }}
      >
        <IconComp size={17} color={t.fg} strokeWidth={2} />
      </div>
      <div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 2 }}>{label}</div>
        <div
          estilo={{
            fontSize: value === "Dados insuficientes" ? 12,5: 14,5,
            Peso da fonte: 600,
            cor: t.fg,
            fontFamily: "'Rajdhani', sem serifa",
            Espaçamento entre letras: 0,3
            alturaDaLinha: 1,25,
          }}
        >
          {valor}
        </div>
      </div>
    </div>
  );
}

função Campo({ rótulo, filhos }) {
  retornar (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <label
        estilo={{
          Tamanho da fonte: 11,5,
          Peso da fonte: 600,
          Espaçamento entre letras: 1,
          textTransform: "maiúsculas",
          cor: C.suave,
        }}
      >
        {rótulo}
      </label>
      {crianças}
    </div>
  );
}

const inputBase = {
  largura: "100%",
  boxSizing: "border-box",
  fundo: C.surfaceInput,
  borda: `1px sólida ${C.border}`,
  borderRadius: 14,
  preenchimento: "14px 16px",
  Tamanho da fonte: 16,
  cor: C.texto,
  fontFamily: "'Inter', sans-serif",
  esboço: "nenhum",
};

function TextField({ value, onChange, placeholder, inputMode, maxLength, prefix, type = "text", autoComplete }) {
  const [focused, setFocused] = useState(false);
  retornar (
    <div style={{ position: "relative" }}>
      {prefixo && (
        <span
          estilo={{
            posição: "absoluta",
            esquerda: 16,
            topo: "50%",
            transformar: "translateY(-50%)",
            cor: valor ? C.texto : C.fraco,
            fontFamily: "'JetBrains Mono', monospace",
            Tamanho da fonte: 15,
            Peso da fonte: 600,
            pointerEvents: "nenhum",
          }}
        >
          {prefixo}
        </span>
      )}
      <entrada
        tipo={tipo}
        valor={valor}
        onChange={onChange}
        espaço reservado={espaço reservado}
        modoDeEntrada={modoDeEntrada}
        comprimentomáximo={comprimentomáximo}
        autoComplete={autoComplete}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        estilo={{
          ...entradaBase,
          paddingLeft: prefixo ? 40 : 16,
          borderColor: focused ? C.gold : C.border,
          boxShadow: focado ? `0 0 0 3px ${C.gold}22` : "nenhum",
          fontFamily: inputMode === "numeric" ? "'JetBrains Mono', monospace" : "'Inter', sans-serif",
          transição: "border-color 160ms, box-shadow 160ms",
        }}
      />
    </div>
  );
}

// Mesma casca visual do TextField (mesma altura, borda, raio, foco dourado),
// só que como <select> nativo — mantém teclado/seletor nativo no mobile e
// evita reconstruir um combobox personalizado só para listar marca/modelo/ano.
função SelectField({ valor, onChange, opções, placeholder, disabled, loading }) {
  const [focused, setFocused] = useState(false);
  const isEmpty = !value;
  retornar (
    <div style={{ position: "relative" }}>
      <selecionar
        valor={valor}
        onChange={onChange}
        desativado={desativado}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        estilo={{
          ...entradaBase,
          aparência: "nenhuma",
          WebkitAppearance: "nenhum",
          MozAppearance: "nenhum",
          paddingRight: 40,
          cor: está vazio ? C.fraco : C.texto,
          borderColor: focused ? C.gold : C.border,
          boxShadow: focado ? `0 0 0 3px ${C.gold}22` : "nenhum",
          opacidade: desativada ? 0,6 : 1,
          cursor: desativado ? "não permitido" : "ponteiro",
          transição: "border-color 160ms, box-shadow 160ms",
        }}
      >
        <option value="" disabled>
          {carregando ? "Carregando…" : espaço reservado}
        </option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <Ícone de seta para baixo>
        tamanho={16}
        cor={C.faint}
        estilo={{
          posição: "absoluta",
          direita: 14,
          topo: "50%",
          transformar: "translateY(-50%)",
          pointerEvents: "nenhum",
        }}
      />
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, icon }) {
  retornar (
    <botão
      onClick={onClick}
      desativado={desativado}
      estilo={{
        largura: "100%",
        fronteira: "nenhuma",
        borderRadius: 16,
        preenchimento: "17px 20px",
        fundo: desativado
          ? C.superfícieElevada
          : `linear-gradient(135deg, ${C.gold}, #C99A34)`,
        cor: desativada ? C.faint : "#171006",
        fontFamily: "'Rajdhani', sem serifa",
        Peso da fonte: 700,
        Tamanho da fonte: 16,5
        Espaçamento entre letras: 1,1
        textTransform: "maiúsculas",
        exibir: "flex",
        alignItems: "center",
        justifyContent: "centro",
        intervalo: 10,
        cursor: desativado ? "não permitido" : "ponteiro",
        boxShadow: desativado ? "nenhum" : `0 8px 24px -8px ${C.gold}88`,
        transição: "transformar 120ms suavizado",
      }}
      onMouseDown={(e) => !disabled && (e.currentTarget.style.transform = "scale(0.98)")}
      onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
      onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
    >
      {ícone}
      {crianças}
    </button>
  );
}

function SecondaryButton({ children, onClick, style }) {
  retornar (
    <botão
      onClick={onClick}
      estilo={{
        largura: "100%",
        borda: `1px sólida ${C.border}`,
        borderRadius: 16,
        preenchimento: "15px 20px",
        fundo: "transparente",
        cor: C.texto,
        fontFamily: "'Rajdhani', sem serifa",
        Peso da fonte: 600,
        Tamanho da fonte: 15,5
        Espaçamento entre letras: 0,6
        textTransform: "maiúsculas",
        cursor: "ponteiro",
        ...estilo,
      }}
    >
      {crianças}
    </button>
  );
}

função GhostLink({ filhos, onClick }) {
  retornar (
    <botão
      onClick={onClick}
      estilo={{
        fronteira: "nenhuma",
        fundo: "transparente",
        cor: C.fraca,
        Tamanho da fonte: 12,5,
        fontFamily: "'Inter', sans-serif",
        textDecoration: "sublinhado",
        textUnderlineOffset: 3,
        cursor: "ponteiro",
        acolchoamento: 6,
      }}
    >
      {crianças}
    </button>
  );
}

função BackHeader({ onBack, título, direita }) {
  retornar (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 22 }}>
      <botão
        onClick={onBack}
        aria-label="Voltar"
        estilo={{
          largura: 38,
          altura: 38,
          larguraMínima: 38,
          borderRadius: 12,
          fundo: C.superfícieRaised,
          borda: `1px sólida ${C.border}`,
          exibir: "flex",
          alignItems: "center",
          justifyContent: "centro",
          cursor: "ponteiro",
        }}
      >
        <ChevronLeftIcon size={19} color={C.text} />
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
        <span
          estilo={{
            fontFamily: "'Rajdhani', sem serifa",
            Peso da fonte: 700,
            Tamanho da fonte: 17,
            cor: C.texto,
            Espaçamento entre letras: 0,3
          }}
        >
          {título}
        </span>
      </div>
      {certo}
    </div>
  );
}

função Logo({ tamanho = 30 }) {
  retornar (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div
        estilo={{
          largura: tamanho,
          altura: tamanho,
          raioDaBorda: tamanho * 0,3,
          fundo: `linear-gradient(135deg, ${C.gold}, #B9862A)`,
          exibir: "flex",
          alignItems: "center",
          justifyContent: "centro",
          boxShadow: `0 4px 14px -4px ${C.gold}99`,
        }}
      >
        <GaugeSmallIcon size={size * 0.58} color="#171006" strokeWidth={2.2} />
      </div>
      <span
        estilo={{
          fontFamily: "'Rajdhani', sem serifa",
          Peso da fonte: 700,
          tamanho da fonte: tamanho * 0,62,
          cor: C.texto,
          Espaçamento entre letras: 0,5
        }}
      >
        VALOR<span style={{ color: C.gold }}>?</span>
      </span>
    </div>
  );
}

função Toast({ mensagem }) {
  se (!mensagem) retorne nulo;
  retornar (
    <div
      estilo={{
        posição: "absoluta",
        parte inferior: 108,
        esquerda: "50%",
        transformar: "translateX(-50%)",
        fundo: C.superfícieRaised,
        borda: `1px sólida ${C.borderStrong}`,
        cor: C.texto,
        Tamanho da fonte: 13,5
        fontFamily: "'Inter', sans-serif",
        preenchimento: "10px 16px",
        borderRadius: 12,
        boxShadow: "0 10px 30px -10px rgba(0,0,0,0.6)",
        zIndex: 50,
        animação: "vale-toast-in 220ms ease",
        whiteSpace: "nowrap",
      }}
    >
      {mensagem}
    </div>
  );
}

// Selo discreto de acesso (análises grátis / PRO) — nunca é um contador
// falso, é sempre derivado de computeAccess() a partir da contagem real.
função AccessBadge({ acesso }) {
  se (!acesso) retorne nulo;

  se (access.status === "PREMIUM") {
    retornar (
      <div
        estilo={{
          exibir: "inline-flex",
          alignItems: "center",
          intervalo: 5,
          fundo: `linear-gradient(135deg, ${C.gold}22, ${C.gold}11)`,
          borda: `1px sólida ${C.gold}55`,
          cor: C.dourado,
          Tamanho da fonte: 11,
          Peso da fonte: 700,
          Espaçamento entre letras: 0,8
          preenchimento: "6px 10px",
          borderRadius: 999,
          fontFamily: "'Rajdhani', sem serifa",
        }}
      >
        <ZapIcon size={11} color={C.gold} />
        VALE? PRO
      </div>
    );
  }

  se (access.status === "FREE_ANALYSES_REMAINING") {
    const label =
      acesso.remaining === 1? "1 análise grátis restante" : `${access.remaining} análises grátis restantes`;
    retornar (
      <div
        estilo={{
          exibir: "inline-flex",
          alignItems: "center",
          intervalo: 6,
          fundo: C.superfícieRaised,
          borda: `1px sólida ${C.border}`,
          cor: C.suave,
          Tamanho da fonte: 11,
          Peso da fonte: 500,
          preenchimento: "6px 10px",
          borderRadius: 999,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: 999, background: C.green }} />
        {rótulo}
      </div>
    );
  }

  // USED_ANALYSES: as gratuitas acabaram e o usuário ainda não é premium.
  retornar (
    <div
      estilo={{
        exibir: "inline-flex",
        alignItems: "center",
        intervalo: 6,
        fundo: C.superfícieRaised,
        borda: `1px sólida ${C.border}`,
        cor: C.fraca,
        Tamanho da fonte: 11,
        Peso da fonte: 500,
        preenchimento: "6px 10px",
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
função LoadingScreen() {
  retornar (
    <div
      estilo={{
        flex: 1,
        exibir: "flex",
        flexDirection: "coluna",
        alignItems: "center",
        justifyContent: "centro",
        intervalo: 14,
      }}
    >
      <div
        estilo={{
          largura: 46,
          altura: 46,
          borderRadius: 14,
          borda: `2px sólida ${C.border}`,
          borderTopColor: C.gold,
          animação: "rotação de vala 800ms linear infinita",
        }}
      />
    </div>
  );
}

function AuthScreen({ onSignUp, onSignIn }) {
  const [mode, setMode] = useState("signup"); // 'signup' | 'login'
  const [nome, setNome] = useState("");
  const [email, setEmail] = useState("");
  const [senha, definirSenha] = useState("");
  const [carregando, setLoading] = useState(false);
  const [erro, setError] = useState("");
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  const isSignup = mode === "signup";
  const podeEnviar =
    (!isSignup || name.trim().length > 0) && email.trim().length > 3 && password.length >= 6 && !loading;

  const handleSubmit = async () => {
    se (!canSubmit) retornar;
    definirCarregando(verdadeiro);
    setError("");
    tentar {
      se (isSignup) {
        const result = await onSignUp(name.trim(), email.trim(), password);
        se (!resultado || !resultado.confirmado) {
          setAwaitingConfirmation(true);
        }
      } outro {
        aguarde onSignIn(email.trim(), senha);
      }
    } catch (e) {
      setError(e.message || "Não foi possível completar a solicitação.");
    } finalmente {
      definirCarregando(falso);
    }
  };

  se (aguardandoConfirmação) {
    retornar (
      <div
        estilo={{
          flex: 1,
          exibir: "flex",
          flexDirection: "coluna",
          justifyContent: "centro",
          alignItems: "center",
          alinhamento do texto: "centro",
          intervalo: 18,
          preenchimento: "0 24px 28px",
          animação: "fade-in de 380ms com efeito suave",
        }}
      >
        <Logo size={36} />
        <h1
          estilo={{
            fontFamily: "'Rajdhani', sem serifa",
            Peso da fonte: 700,
            Tamanho da fonte: 22,
            cor: C.texto,
            margem: 0,
            largura máxima: 280,
            alturaDaLinha: 1,3,
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
            setAwaitingConfirmation(falso);
            setMode("login");
            definirSenha("");
          }}
        >
          Voltar para o login
        </GhostLink>
      </div>
    );
  }

  retornar (
    <div
      estilo={{
        flex: 1,
        exibir: "flex",
        flexDirection: "coluna",
        justifyContent: "espaço-entre",
        preenchimento: "0 24px 28px",
        animação: "fade-in de 380ms com efeito suave",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 18 }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 20 }}>
          <Logo size={40} />
          {isSignup && (
            <div
              estilo={{
                exibir: "inline-flex",
                alignItems: "center",
                intervalo: 6,
                fundo: `${C.green}15`,
                borda: `1px sólida ${C.green}44`,
                cor: verde-claro,
                Tamanho da fonte: 12,
                Peso da fonte: 600,
                preenchimento: "6px 12px",
                borderRadius: 999,
              }}
            >
              <ZapIcon size={12} color={C.green} />
              3 análises grátis, sem compromisso
            </div>
          )}
          <h1
            estilo={{
              fontFamily: "'Rajdhani', sem serifa",
              Peso da fonte: 700,
              Tamanho da fonte: 27,
              cor: C.texto,
              margem: 0,
              larguramáxima: 300,
              alturaDaLinha: 1,3,
            }}
          >
            {isSignup? "Crie sua conta grátis." : "Bem-vindo de volta."}
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
              <Campo de texto
                valor={nome}
                onChange={(e) => setName(e.target.value)}
                placeholder="Seu nome"
                autoComplete="nome"
              />
            </Campo>
          )}
          <Field label="E-mail">
            <Campo de texto
              valor={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="voce@email.com"
              inputMode="email"
              autoComplete="email"
            />
          </Campo>
          <Field label="Senha">
            <Campo de texto
              valor={senha}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              tipo="senha"
              autoComplete={isSignup ? "nova-senha" : "senha-atual"}
            />
          </Campo>
          {erro && (
            <p style={{ fontSize: 12.5, color: C.red, margin: 0, lineHeight: 1.5 }}>{erro}</p>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center" }}>
        <PrimaryButton onClick={handleSubmit} disabled={!canSubmit} icon={<ZapIcon size={17} color="#171006" />}>
          {carregando ? "Um instante…" : isSignup ? "Criar conta" : "Entrar"}
        </PrimaryButton>
        <GhostLink
          onClick={() => {
            setMode(isSignup ? "login" : "signup");
            setError("");
          }}
        >
          {isSignup? "Já tem conta? Entrar" : "Não tem conta? Criar uma"}
        </GhostLink>
      </div>
    </div>
  );
}

função HomeScreen({ onStart, access, onLogout }) {
  retornar (
    <div
      estilo={{
        flex: 1,
        exibir: "flex",
        flexDirection: "coluna",
        justifyContent: "espaço-entre",
        preenchimento: "0 24px 28px",
        animação: "fade-in de 380ms com efeito suave",
      }}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center", gap: 22 }}>
        <div
          estilo={{
            largura: 84,
            altura: 84,
            borderRadius: 24,
            fundo: `radial-gradient(circle at 30% 25%, #2a2210, ${C.surface})`,
            borda: `1px sólida ${C.border}`,
            exibir: "flex",
            alignItems: "center",
            justifyContent: "centro",
            margemInferior: 4,
          }}
        >
          <GaugeSmallIcon size={40} color={C.gold} strokeWidth={1.6} />
        </div>

        <div>
          <h1
            estilo={{
              fontFamily: "'Rajdhani', sem serifa",
              Peso da fonte: 700,
              Tamanho da fonte: 52,
              Espaçamento entre letras: 1,
              margem: 0,
              cor: C.texto,
              alturaDaLinha: 1,
            }}
          >
            VALOR<span style={{ color: C.gold }}>?</span>
          </h1>
        </div>

        <p
          estilo={{
            fontFamily: "'Rajdhani', sem serifa",
            Peso da fonte: 600,
            Tamanho da fonte: 19,
            cor: C.texto,
            margem: 0,
            largura máxima: 280,
            alturaDaLinha: 1,35,
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

function FormScreen({formulário, setForm, onSubmit, onBack, accessToken, externalError }) {
  const [marcas, setMarcas] = useState([]);
  const [models, setModels] = useState([]);
  const [anos, setAnos] = useState([]);
  const [loadingBrands, setLoadingBrands] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingYears, setLoadingYears] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  // 1) Ao abrir o formulário, carrega as marcas reais da FIPE.
  useEffect(() => {
    seja cancelado = falso;
    se (!accessToken) {
      setLoadError("Sua sessão expirou. Volte e entre novamente.");
      retornar;
    }
    setLoadingBrands(true);
    setLoadError("");
    buscarFipeBrands(accessToken)
      .then((dados) => {
        se (cancelado) retornar;
        setBrands(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        se (cancelado) retornar;
        setLoadError("Não foi possível carregar as marcas da FIPE agora. Tente novamente.");
      })
      .finalmente(() => {
        se (!cancelado) definirLoadingBrands(falso);
      });
    retornar () => {
      cancelado = verdadeiro;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, retryKey]);

  // 3) Depois que a marca é escolhida, carrega os modelos dela.
  useEffect(() => {
    seja cancelado = falso;
    setModels([]);
    setYears([]);
    Se (!form.brandId || !accessToken) retornar;
    setLoadingModels(true);
    setLoadError("");
    buscarFipeModels(form.brandId, accessToken)
      .then((dados) => {
        se (cancelado) retornar;
        setModels(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        se (cancelado) retornar;
        setLoadError("Não foi possível carregar os modelos dessa marca agora. Tente novamente.");
      })
      .finalmente(() => {
        se (!cancelado) definirLoadingModels(falso);
      });
    retornar () => {
      cancelado = verdadeiro;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.brandId, accessToken, retryKey]);

  // 5) Depois que o modelo é escolhido, carrega os anos dele.
  useEffect(() => {
    seja cancelado = falso;
    setYears([]);
    Se (!form.brandId || !form.modelId || !accessToken) retornar;
    definirAnosDeCarregamento(verdadeiro);
    setLoadError("");
    buscarFipeYears(form.brandId, form.modelId, accessToken)
      .then((dados) => {
        se (cancelado) retornar;
        setYears(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        se (cancelado) retornar;
        setLoadError("Não foi possível carregar os anos desse modelo agora. Tente novamente.");
      })
      .finalmente(() => {
        se (!cancelado) definirAnosDeCarregamento(falso);
      });
    retornar () => {
      cancelado = verdadeiro;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.brandId, form.modelId, accessToken, retryKey]);

  const handleSelectBrand = (e) => {
    const brandId = e.target.value;
    const selected = brands.find((b) => b.code === brandId);
    // Troca de marca invalida modelo e ano já escolhido.
    setForm((f) => ({
      ...f,
      id da marca,
      marca: (selecionada && nome.selecionado) || "",
      modelId: "",
      modelo: "",
      yearId: "",
      ano: "",
    }));
  };

  const handleSelectModel = (e) => {
    const modelId = e.target.value;
    const selected = models.find((m) => m.code === modelId);
    // Troca de modelo invalida o ano já escolhido.
    setForm((f) => ({
      ...f,
      id do modelo,
      modelo: (selecionado && nome.selecionado) || "",
      yearId: "",
      ano: "",
    }));
  };

  const handleSelectYear = (e) => {
    const yearId = e.target.value;
    const selected = years.find((y) => y.code === yearId);
    setForm((f) => ({
      ...f,
      id do ano,
      ano: selecionado ? parseFipeYearNumber(selecionado) : "",
    }));
  };

  const podeAnalisar =
    Boolean(form.brandId) &&
    Boolean(form.modelId) &&
    Boolean(form.yearId) &&
    dígitos(form.km).comprimento > 0 &&
    digits(form.price).length > 0;

  // Erro da consulta de preço (vindo do App, depois do clique em "Analisar
  // carro") tem prioridade sobre um eventual erro de carregamento de
  // marca/modelo/ano — é cada um tenta de novo a coisa certa.
  const displayError = externalError || loadError;
  const handleRetry = () => {
    se (erro externo) {
      onSubmit();
    } outro {
      setRetryKey((k) => k + 1);
    }
  };

  retornar (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="Dados do veículo" />

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1.3 }}>
            <Field label="Marca">
              <SelectField
                valor={form.brandId}
                onChange={handleSelectBrand}
                opções={marcas.map((b) => ({ valor: b.código, rótulo: b.nome }))}
                placeholder={loadError && marcas.length === 0 ? "Indisponível": "Selecione a marca"}
                carregamento={loadingBrands}
                disabled={loadingBrands || (brands.length === 0 && !loadingBrands)}
              />
            </Campo>
          </div>
          <div style={{ flex: 1.7 }}>
            <Field label="Modelo">
              <SelectField
                valor={form.modelId}
                onChange={handleSelectModel}
                opções={modelos.map((m) => ({ valor: m.código, rótulo: m.nome }))}
                placeholder={!form.brandId ? "Selecione a marca primeiro" : "Selecione o modelo"}
                carregamento={loadingModels}
                disabled={!form.brandId || loadingModels || (models.length === 0 && !loadingModels)}
              />
            </Campo>
          </div>
        </div>

        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <Field label="Ano">
              <SelectField
                valor={form.yearId}
                onChange={handleSelectYear}
                opções={anos.map((y) => ({ valor: y.código, rótulo: y.nome }))}
                placeholder={!form.modelId ? "Selecione o modelo primeiro" : "Selecione o ano"}
                carregamento={loadingYears}
                disabled={!form.modelId || loadingYears || (years.length === 0 && !loadingYears)}
              />
            </Campo>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="Quilo">
              <Campo de texto
                valor={form.km}
                onChange={(e) => setForm((f) => ({ ...f, km: fmtThousands(digits(e.target.value)) }))}
                placeholder="45.000"
                modoDeEntrada="numérico"
              />
            </Campo>
          </div>
        </div>

        <Field label="Preço anunciado">
          <Campo de texto
            valor={form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: fmtThousands(digits(e.target.value)) }))}
            placeholder="62.000"
            modoDeEntrada="numérico"
            prefixo="R$"
          />
        </Campo>

        {displayError ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "-4px 2px 0" }}>
            <p style={{ fontSize: 12.5, color: C.red, margin: 0, lineHeight: 1.5, flex: 1 }}>{displayError}</p>
            <GhostLink onClick={handleRetry}>Tentando novamente</GhostLink>
          </div>
        ) : (
          <p style={{ fontSize: 11.5, color: C.faint, margin: "4px 2px 0", lineHeight: 1.5 }}>
            Marca, modelo e ano vêm direto da tabela FIPE.
          </p>
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <PrimaryButton onClick={onSubmit} disabled={!canAnalyze}>
          Analisar carro
        </PrimaryButton>
      </div>
    </div>
  );
}

const ANALISANDO_MENSAGENS = [
  "Lendo os dados do veículo…",
  "Consultando a tabela FIPE…",
  "Calculando a nota…",
];

// Não recebe mais um onDone com timer fixo: fica em loop pelas mensagens
// enquanto o App aguarda a resposta real da FIPE (fetchFipeDetail) — quem
// decide quando sair dessa tela é o App, trocando o `screen`.
função AnalisandoTela() {
  const [passo, definirPasso] = useState(0);

  useEffect(() => {
    const stepTimer = setInterval(() => {
      setStep((s) => (s + 1) % ANALYZING_MESSAGES.length);
    }, 900);
    retornar () => clearInterval(stepTimer);
  }, []);

  retornar (
    <div
      estilo={{
        flex: 1,
        exibir: "flex",
        flexDirection: "coluna",
        alignItems: "center",
        justifyContent: "centro",
        intervalo: 24,
        preenchimento: "0 24px",
      }}
    >
      <div style={{ position: "relative", width: 76, height: 76 }}>
        <div
          estilo={{
            posição: "absoluta",
            inserção: 0,
            borderRadius: "50%",
            borda: `3px sólida ${C.border}`,
            borderTopColor: C.gold,
            animação: "rotação de vala 900ms linear infinita",
          }}
        />
        <div
          estilo={{
            posição: "absoluta",
            inserção: 0,
            exibir: "flex",
            alignItems: "center",
            justifyContent: "centro",
          }}
        >
          <GaugeSmallIcon size={28} color={C.gold} strokeWidth={1.6} />
        </div>
      </div>
      <span
        chave={passo}
        estilo={{
          fontFamily: "'Rajdhani', sem serifa",
          Peso da fonte: 600,
          Tamanho da fonte: 16,
          cor: C.suave,
          animação: "fade-in de 250ms com efeito suave",
        }}
      >
        {ANALISANDO_MENSAGENS[etapa]}
      </span>
    </div>
  );
}

função Row({ label, value, muted, valueColor }) {
  retornar (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: 13.5, color: C.muted }}>{label}</span>
      <span
        estilo={{
          fontFamily: "'JetBrains Mono', monospace",
          Tamanho da fonte: 15,5
          Peso da fonte: 600,
          cor: valueColor || (silencioso ? C.silencioso : C.texto),
        }}
      >
        {valor}
      </span>
    </div>
  );
}

função ResultScreen({ resultado, onBack, onRestart }) {
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);

  const showToast = (msg) => {
    setToast(msg);
    clearTimeout(toastTimeout.current);
    toastTimer.current = setTimeout(() => setToast(""), 2200);
  };

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const handleShare = async () => {
    const text = `VALE?\n${result.fipe.brand} ${result.fipe.model} · ${result.fipe.modelYear}\n${result.score.toFixed(
      1
    )}/10 — ${result.verdictLabel}\n${fmtBRL(result.priceNum)}\nAnalisado pelo VALE?`;
    tentar {
      se (navegador.compartilhar) {
        await navigator.share({ title: "Minha análise VALE?", texto });
      } outro {
        aguarde navigator.clipboard.writeText(text);
        showToast("Análise copiada!");
      }
    } catch (e) {
      // usuário cancelou o compartilhamento — nada a fazer
    }
  };

  const tone = TONE[result.verdictTone];
  const diffLabel = `${result.diffPct >= 0 ? "+" : ""}${result.diffPct.toFixed(1)}%`;

  retornar (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", position: "relative", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="Resultado da análise" />

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, paddingBottom: 4 }}>
        {/* veículo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            estilo={{
              largura: 40,
              altura: 40,
              borderRadius: 12,
              fundo: C.superfícieRaised,
              borda: `1px sólida ${C.border}`,
              exibir: "flex",
              alignItems: "center",
              justifyContent: "centro",
            }}
          >
            <CarIcon size={20} color={C.gold} />
          </div>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 19, color: C.text }}>
            {result.fipe.brand} {result.fipe.model} <span style={{ color: C.muted }}>· {result.fipe.modelYear}</span>
          </div>
        </div>

        {/* Gauge + veredito */}
        <div
          estilo={{
            background: `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            borda: `1px sólida ${C.border}`,
            borderRadius: 22,
            preenchimento: "26px 20px 22px",
            exibir: "flex",
            flexDirection: "coluna",
            alignItems: "center",
            animação: "fade-in de 420ms com efeito suave",
          }}
        >
          <ScoreGauge score={result.score} tone={result.verdictTone} />
          <div
            estilo={{
              margemSuperior: 6,
              exibir: "inline-flex",
              alignItems: "center",
              intervalo: 8,
              fundo: tom.bg,
              cor: tom.fg,
              borda: `1px sólida ${tone.fg}33`,
              preenchimento: "8px 18px",
              borderRadius: 999,
              fontFamily: "'Rajdhani', sem serifa",
              Peso da fonte: 700,
              Tamanho da fonte: 15,5
              Espaçamento entre letras: 1,
            }}
          >
            {result.verdictTone === "ruim" ? (
              <AlertTriangleIcon size={15} color={tone.fg} strokeWidth={2.2} />
            ) : (
              <CheckIcon size={15} color={tone.fg} strokeWidth={2.6} />
            )}
            {result.verdictLabel}
          </div>
        </div>

        {/* Preços */}
        <div
          estilo={{
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            borderRadius: 18,
            acolchoamento: 18,
            exibir: "flex",
            flexDirection: "coluna",
            intervalo: 12,
            animação: "fade-in de 460ms com efeito suave",
          }}
        >
          <Row label="Preço anunciado" value={fmtBRL(result.priceNum)} />
          <div style={{ height: 1, background: C.border }} />
          <Row label="Preço de referência" value={fmtBRL(result.referencePrice)} silenciado />
          <div style={{ height: 1, background: C.border }} />
          <Linha
            rótulo="Diferença"
            valor={diffLabel}
            valueColor={result.diffPct <= -5 ? C.green : result.diffPct >= 5 ? C.red : C.amber}
          />
          <div
            estilo={{
              exibir: "flex",
              alignItems: "center",
              intervalo: 6,
              margemSuperior: 2,
              Tamanho da fonte: 11,
              cor: C.fraca,
            }}
          >
            <span
              estilo={{
                fundo: C.surfaceInput,
                borda: `1px sólida ${C.border}`,
                borderRadius: 999,
                preenchimento: "3px 9px",
                Espaçamento entre letras: 0,4
              }}
            >
              REFERÊNCIA FIPE
            </span>
            <span>FIPE • {result.fipe.referenceMonth}</span>
          </div>
        </div>

        {/* → */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, animation: "vale-fade-in 500ms ease" }}>
          {result.indicators.map((ind) => (
            <IndicatorChip key={ind.key} icon={ind.Icon} label={ind.label} value={ind.value} tone={ind.tone} />
          ))}
        </div>

        {/* Veredito */}
        <div
          estilo={{
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            borderRadius: 18,
            acolchoamento: 18,
            animação: "fade-in de 540ms com efeito suave",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <BulbIcon size={17} color={C.gold} strokeWidth={1.8} />
            <span
              estilo={{
                fontFamily: "'Rajdhani', sem serifa",
                Peso da fonte: 700,
                Tamanho da fonte: 14,5
                Espaçamento entre letras: 1,
                cor: C.texto,
                textTransform: "maiúsculas",
              }}
            >
              Nosso veredito
            </span>
          </div>
          <p style={{ fontSize: 14, color: C.muted, lineHeight: 1.65, margin: 0 }}>{result.verdictText}</p>
        </div>

        {/* Lista de verificação */}
        <div
          estilo={{
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            borderRadius: 18,
            acolchoamento: 18,
            animação: "fade-in de 580ms com efeito suave",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <AlertTriangleIcon size={16} color={C.amber} strokeWidth={2} />
            <span
              estilo={{
                fontFamily: "'Rajdhani', sem serifa",
                Peso da fonte: 700,
                Tamanho da fonte: 14,5
                Espaçamento entre letras: 1,
                cor: C.texto,
                textTransform: "maiúsculas",
              }}
            >
              Antes de comprar
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              "Faça avaliação mecânica",
              "Verifique o histórico de manutenção",
              "Faça laudo cautelar",
              "Confira documentação",
              "Faça um test-drive",
            ].map((item) => (
              <div key={item} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div
                  estilo={{
                    largura: 20,
                    altura: 20,
                    larguraMínima: 20,
                    borderRadius: 7,
                    fundo: C.greenDim,
                    exibir: "flex",
                    alignItems: "center",
                    justifyContent: "centro",
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
  retornar (
    <div
      estilo={{
        flex: 1,
        exibir: "flex",
        flexDirection: "coluna",
        preenchimento: "0 24px 24px",
        animação: "fade-in de 380ms com efeito suave",
      }}
    >
      <div
        estilo={{
          flex: 1,
          overflowY: "auto",
          exibir: "flex",
          flexDirection: "coluna",
          justifyContent: "centro",
          alignItems: "center",
          alinhamento do texto: "centro",
          intervalo: 16,
          paddingTop: 12,
        }}
      >
        <div
          estilo={{
            largura: 68,
            altura: 68,
            borderRadius: 20,
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            exibir: "flex",
            alignItems: "center",
            justifyContent: "centro",
          }}
        >
          <LockIcon size={28} color={C.gold} strokeWidth={1.7} />
        </div>

        <h1
          estilo={{
            fontFamily: "'Rajdhani', sem serifa",
            Peso da fonte: 700,
            Tamanho da fonte: 24,
            cor: C.texto,
            margem: 0,
            largura máxima: 280,
            alturaDaLinha: 1,3,
          }}
        >
          Suas 3 análises gratuitas terminaram
        </h1>

        <p style={{ fontSize: 14, color: C.muted, margin: 0, maxWidth: 300, lineHeight: 1.65 }}>
          Você já experimentou o VALE?. Continue analisando carros e descubra se realmente vale a pena antes de
          comprar.
        </p>

        <div
          estilo={{
            margemSuperior: 6,
            largura: "100%",
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.gold}44`,
            borderRadius: 18,
            preenchimento: "16px 18px",
            exibir: "flex",
            alignItems: "center",
            justifyContent: "espaço-entre",
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
          estilo={{
            largura: "100%",
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            borderRadius: 18,
            acolchoamento: 16,
            exibir: "flex",
            flexDirection: "coluna",
            intervalo: 11,
            alinhamento do texto: "esquerda",
          }}
        >
          {PAYWALL_BENEFITS.map((b) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                estilo={{
                  largura: 18,
                  altura: 18,
                  larguraMínima: 18,
                  borderRadius: 6,
                  fundo: C.greenDim,
                  exibir: "flex",
                  alignItems: "center",
                  justifyContent: "centro",
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
        </BotãoSecundário>
      </div>
    </div>
  );
}

const PAYWALL_BENEFÍCIOS = [
  "Novas análises de veículos",
  "Análise de preço",
  "Comparação com preço de referência",
  "Indicadores do veículo",
  "Veredito antes da compra",
];

const PRO_BENEFÍCIOS = [
  "Análises ilimitados",
  "Comparação com preço de referência",
  "Nota de 0 a 10",
  "Indicadores da análise",
  "Veredito do VALE?",
  "Compartilhamento das análises",
];

função OfferScreen({ onBack, onSubscribe }) {
  const demoMode = !ACCESS_CONFIG.CHECKOUT_URL;

  retornar (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", padding: "0 24px 24px", animation: "vale-slide-in 320ms ease" }}>
      <BackHeader onBack={onBack} title="VALE? PRO" />

      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18, paddingBottom: 4 }}>
        <div style={{ textAlign: "center", padding: "6px 4px 2px" }}>
          <h1
            estilo={{
              fontFamily: "'Rajdhani', sem serifa",
              Peso da fonte: 700,
              Tamanho da fonte: 24,
              cor: C.texto,
              margem: "0 0 10px",
              alturaDaLinha: 1,3,
            }}
          >
            Continue descobrindo se vale a pena.
          </h1>
          <p style={{ fontSize: 13.5, color: C.muted, margin: 0, lineHeight: 1.6 }}>
            Você teve acesso às análises da VALE? e tome decisões mais inteligentes antes de comprar seu próximo carro.
          </p>
        </div>

        <div
          estilo={{
            background: `linear-gradient(180deg, ${C.surface}, ${C.surfaceRaised})`,
            borda: `1px sólida ${C.gold}44`,
            borderRadius: 20,
            preenchimento: "20px 20px",
            alinhamento do texto: "centro",
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
          estilo={{
            fundo: C.superfícieRaised,
            borda: `1px sólida ${C.border}`,
            borderRadius: 18,
            acolchoamento: 18,
            exibir: "flex",
            flexDirection: "coluna",
            intervalo: 13,
          }}
        >
          {PRO_BENEFÍCIOS.map((b) => (
            <div key={b} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                estilo={{
                  largura: 20,
                  altura: 20,
                  larguraMínima: 20,
                  borderRadius: 7,
                  fundo: C.greenDim,
                  exibir: "flex",
                  alignItems: "center",
                  justifyContent: "centro",
                }}
              >
                <CheckIcon size={12} color={C.green} strokeWidth={2.8} />
              </div>
              <span style={{ fontSize: 14, color: C.text }}>{b}</span>
            </div>
          ))}
        </div>

        {modo de demonstração && (
          <div
            estilo={{
              borda: `1px tracejada ${C.border}`,
              borderRadius: 14,
              preenchimento: "10px 14px",
              Tamanho da fonte: 11,5,
              cor: C.fraca,
              alturaDaLinha: 1,5,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            CHECKOUT_URL não configurado — este botão ativa um modo de demonstração local para testar o fluxo.
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 16, alignItems: "center" }}>
        <PrimaryButton onClick={onSubscribe} icon={<ZapIcon size={17} color="#171006" />}>
          Assinar VALE? PROFISSIONAL
        </PrimaryButton>
        <p style={{ fontSize: 11, color: C.faint, margin: 0, textAlign: "center" }}>
          Pagamento realizado através do checkout.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Aplicativo
// ---------------------------------------------------------------------------
const emptyForm = { marca: "", idMarca: "", modelo: "", idModelo: "", ano: "", idAno: "", km: "", preço: "" };

export default function App() {
  const [screen, setScreen] = useState("loading");
  // 'carregando' | 'autenticação' | 'página inicial' | 'formulário' | 'analisando' | 'resultado' | 'paywall' | 'oferta'
  const [form, setForm] = useState(emptyForm);
  const [análiseResult, setAnalysisResult] = useState(null); //AnáliseResultado | null, montado só depois que a FIPE responde
  const [análiseError, setAnalysisError] = useState(""); // erro da consulta FIPE, agendamento de volta no formulário
  const [session, setSession] = useState(null); // { access_token, refresh_token, expires_at, user } | null
  const [perfil, setProfile] = useState(null); // linha de public.profiles vinda do Supabase | nulo

  // Ao abrir o app: tente reaproveitar a sessão salva localmente (só o
  // token), renova se necessário, e SEMPRE busca o perfil de novo no
  // Supabase — o cache nunca decide sozinho se o usuário tem acesso.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const cached = await loadCachedSession();
      se (!em cache) {
        se (montado) definirTela("auth");
        retornar;
      }

      let activeSession = cached;
      const nowSec = Math.floor(Date.now() / 1000);
      se (!cached.expires_at || cached.expires_at <= nowSec + 30) {
        const refreshed = await supaRefreshSession(cached.refresh_token);
        se (!atualizado) {
          aguarde limparCachedSession();
          se (montado) definirTela("auth");
          retornar;
        }
        activeSession = sessionFromAuthResponse(atualizado);
        aguardar salvarCachedSession(activeSession);
      }

      const freshProfile = await supaFetchProfileWithRetry(activeSession.access_token);
      se (!montado) retornar;
      se (!freshProfile) {
        // Token inválido/perfil não encontrado -> pede login de novo.
        aguarde limparCachedSession();
        setScreen("auth");
        retornar;
      }
      setSession(activeSession);
      definirPerfil(perfilfresco);
      setScreen("home");
    })();
    retornar () => {
      montado = falso;
    };
  }, []);

  const acesso = useMemo(() => computeAccess(profile), [profile]);

  // Depois de um cadastro (com confirmação de e-mail desativado) ou login
  // bem-sucedido: guarda a sessão (cache local) e busca o perfil de
  // verdade no Supabase antes de liberar a Home.
  const estabelecerSessão = async (dadosAutenticação) => {
    const newSession = sessionFromAuthResponse(authData);
    setSession(newSession);
    aguardar salvarCachedSession(novaSessão);
    const freshProfile = await supaFetchProfileWithRetry(newSession.access_token);
    definirPerfil(perfilfresco);
    setScreen("home");
  };

  const handleSignUp = async (name, email, password) => {
    const data = await supaSignUp(name, email, password);
    se (dados && dados.token_de_acesso) {
      aguardar estabelecerSessão(dados);
      retornar { confirmado: verdadeiro };
    }
    // Sem access_token = o projeto exige confirmação por e-mail antes do
    // primeiro login. O perfil já existe (criado pelo trigger), só falta
    // a pessoa confirma e faz login normalmente.
    retornar { confirmado: falso };
  };

  const handleSignIn = async (email, password) => {
    const data = await supaSignIn(email, password);
    aguardar estabelecerSessão(dados);
  };

  const handleLogout = async () => {
    se (sessão) aguarde supaSignOut(sessão.token_de_acesso);
    aguarde limparCachedSession();
    setSession(null);
    definirPerfil(nulo);
    definirFormulário(formulário vazio);
    definirResultadoDaAnálise(nulo);
    setAnalysisError("");
    setScreen("auth");
  };

  const requestAnalysis = () => {
    se (!canStartAnalysis(access)) {
      setScreen("paywall");
    } outro {
      setScreen("form");
    }
  };

  // Único ponto que fala com a FIPE de verdade pra gerar um resultado.
  // Ordem importante: só contabilização 1 análise grátis (completeAnalysis) DEPOIS
  // que a consulta FIPE já respondeu com sucesso — se ela falhou, nada é
  // descontado, nenhum resultado aparece, e o usuário pode tentar de novo.
  const handleSubmitForm = async () => {
    setAnalysisError("");
    setScreen("analisando");

    deixe fipeData;
    tentar {
      fipeData = await fetchFipeDetail(form.brandId, form.modelId, form.yearId, session && session.access_token);
    } catch (e) {
      setAnalysisError("Não foi possível consultar o preço na FIPE agora. Tente novamente em instantes.");
      setScreen("form");
      retornar;
    }

    const updatedProfile = await completeAnalysis(session);
    se (perfilAtualizado) definirPerfil(perfilAtualizado);

    setAnalysisResult(buildAnalysisResult(form, fipeData));
    setScreen("result");
  };

  const handleNewAnalysis = () => {
    se (!canStartAnalysis(access)) {
      setScreen("paywall");
      retornar;
    }
    definirFormulário(formulário vazio);
    definirResultadoDaAnálise(nulo);
    setAnalysisError("");
    setScreen("form");
  };

  // Usado tanto pelo CTA "Continuar com VALE? PRO" (paywall) quanto pelo
  // botão "Assinar VALE? PRO" (oferta) — ambos levam ao mesmo checkout real.
  const handleSubscribe = () => {
    abrirCheckout();
    // Importante: abrir o checkout NÃO confirmar pagamento. is_premium só
    // pode ser alterado no Supabase (manualmente por enquanto, ou por um
    // backend com service_role reagindo a um webhook real da Cakto no
    // futuro) — nada é ativado aqui no frontend.
  };

  const showHeader = screen === "home";

  retornar (
    <div
      estilo={{
        minHeight: "100vh",
        largura: "100%",
        fundo: `radial-gradient(120% 60% at 50% -10%, #16130a 0%, ${C.bg} 55%)`,
        exibir: "flex",
        justifyContent: "centro",
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

        * { box-sizing: border-box; }
        input::placeholder { color: ${C.faint}; }
        input:focus { outline: none; }
        botão { família-da-fonte: herdar; }

        @keyframes vale-fade-in {
          de { opacidade: 0; transformação: translateY(6px); }
          para { opacidade: 1; transformação: translateY(0); }
        }
        @keyframes vale-slide-in {
          de { opacidade: 0; transformação: translateX(10px); }
          para { opacidade: 1; transformação: translateX(0); }
        }
        @keyframes vale-toast-in {
          de { opacidade: 0; transformação: translate(-50%, 6px); }
          para { opacidade: 1; transformação: traduzir(-50%, 0); }
        }
        @keyframes vale-spin {
          de { transformar: rotacionar(0deg); }
          para { transformar: girar(360 graus); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
        }
      ` estilo de cerveja>

      <div
        estilo={{
          largura: "100%",
          largura máxima: 430,
          minHeight: "100vh",
          exibir: "flex",
          flexDirection: "coluna",
          posição: "relativa",
        }}
      >
        {showHeader && (
          <div style={{ padding: "22px 24px 4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Logotipo />
          </div>
        )}

        {screen === "loading" && <LoadingScreen />}

        {screen === "auth" && <AuthScreen onSignUp={handleSignUp} onSignIn={handleSignIn} />}

        {screen === "home" && <HomeScreen onStart={requestAnalysis} access={access} onLogout={handleLogout} />}

        {screen === "form" && (
          <div style={{ paddingTop: 22 }}>
            <FormScreen
              formulário={formulário}
              setForm={setForm}
              onSubmit={handleSubmitForm}
              onBack={() => setScreen("home")}
              accessToken={session && session.access_token}
              externalError={analysisError}
            />
          </div>
        )}

        {screen === "analisando" && <AnalyzingScreen />}

        {screen === "resultado" && analysisResult && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <ResultScreen result={analysisResult} onBack={() => setScreen("form")} onRestart={handleNewAnalysis} />
          </div>
        )}

        {screen === "paywall" && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <PaywallScreen onContinue={handleSubscribe} onDismiss={() => setScreen("home")} />
          </div>
        )}

        {screen === "oferta" && (
          <div style={{ paddingTop: 22, display: "flex", flexDirection: "column", flex: 1 }}>
            <OfferScreen onBack={() => setScreen("paywall")} onSubscribe={handleSubscribe} />
          </div>
        )}
      </div>
    </div>
  );
}
