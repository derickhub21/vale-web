fontSize: 16,
                color: C.text,
              }}
            >
              {ACCESS_CONFIG.PLAN_NAME}
            </div>
            <div
              style={{
                fontSize: 12,
                color: C.muted,
                marginTop: 2,
              }}
            >
              Análises ilimitadas
            </div>
          </div>

          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 700,
              fontSize: 16,
              color: C.gold,
            }}
          >
            {ACCESS_CONFIG.PRICE_LABEL}
          </div>
        </div>
      </div>

      <div
        style={{
          marginTop: 16,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <PrimaryButton
          onClick={onContinue}
          icon={<ZapIcon size={17} color="#171006" />}
        >
          Desbloquear acesso ilimitado
        </PrimaryButton>

        {onDismiss && (
          <GhostLink onClick={onDismiss}>
            Voltar para a página inicial
          </GhostLink>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState("home"); // 'home' | 'form' | 'analyzing' | 'result' | 'paywall' | 'reset_password'
  const [isResetFlow, setIsResetFlow] = useState(false);

  const [form, setForm] = useState({
    brandId: "",
    brand: "",
    modelId: "",
    model: "",
    yearId: "",
    year: "",
    km: "",
    price: "",
  });

  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState("");

  const access = useMemo(() => computeAccess(profile), [profile]);

  // Checa hash e restaura/valida sessão local ao carregar
  useEffect(() => {
    let active = true;

    async function init() {
      // Captura o hash do Supabase Auth para recuperação de senha
      const hash = window.location.hash;
      if (hash && hash.includes("type=recovery")) {
        const params = new URLSearchParams(hash.replace("#", "?"));
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");

        if (accessToken) {
          const sess = {
            access_token: accessToken,
            refresh_token: refreshToken,
            user: {},
          };
          setSession(sess);
          setIsResetFlow(true);
          setView("reset_password");
          window.history.replaceState(null, "", window.location.pathname);
          setLoading(false);
          return;
        }
      }

      const cached = await loadCachedSession();

      if (!cached || !cached.access_token) {
        if (active) setLoading(false);
        return;
      }

      const prof = await supaFetchProfile(cached.access_token);

      if (prof) {
        if (active) {
          setSession(cached);
          setProfile(prof);
          setLoading(false);
        }
        return;
      }

      if (cached.refresh_token) {
        const refreshed = await supaRefreshSession(cached.refresh_token);

        if (refreshed) {
          const newSession = sessionFromAuthResponse(refreshed);
          const newProf = await supaFetchProfile(newSession.access_token);

          if (active) {
            setSession(newSession);
            setProfile(newProf);
            saveCachedSession(newSession);
            setLoading(false);
          }
          return;
        }
      }

      await clearCachedSession();
      if (active) setLoading(false);
    }

    init();

    return () => {
      active = false;
    };
  }, []);

  const handleSignUp = async (name, email, password) => {
    const data = await supaSignUp(name, email, password);

    if (data && data.access_token) {
      const sess = sessionFromAuthResponse(data);
      setSession(sess);
      saveCachedSession(sess);

      const prof = await supaFetchProfileWithRetry(sess.access_token);
      setProfile(prof);

      return { confirmed: true };
    }

    return { confirmed: false };
  };

  const handleSignIn = async (email, password) => {
    const data = await supaSignIn(email, password);
    const sess = sessionFromAuthResponse(data);

    setSession(sess);
    saveCachedSession(sess);

    const prof = await supaFetchProfileWithRetry(sess.access_token);
    setProfile(prof);
  };

  const handleForgotPassword = async (email) => {
    await supaSendPasswordRecovery(email);
  };

  const handleUpdatePassword = async (newPassword) => {
    if (!session?.access_token) return;

    await supaUpdatePassword(session.access_token, newPassword);
    setIsResetFlow(false);
    setView("home");
  };

  const handleLogout = async () => {
    if (session?.access_token) {
      supaSignOut(session.access_token);
    }

    await clearCachedSession();
    setSession(null);
    setProfile(null);
    setView("home");
    setForm({
      brandId: "",
      brand: "",
      modelId: "",
      model: "",
      yearId: "",
      year: "",
      km: "",
      price: "",
    });
    setResult(null);
  };

  const handleStart = () => {
    if (!canStartAnalysis(access)) {
      setView("paywall");
      return;
    }

    setFormError("");
    setView("form");
  };

  const handleFormSubmit = async () => {
    if (!canStartAnalysis(access)) {
      setView("paywall");
      return;
    }

    setFormError("");
    setView("analyzing");

    try {
      // 1. Busca veículo real na FIPE via Edge Function
      const fipeData = await fetchFipeDetail(
        form.brandId,
        form.modelId,
        form.yearId,
        session.access_token
      );

      // 2. Constrói o resultado da análise usando os dados reais
      const analysisRes = buildAnalysisResult(form, fipeData);

      // 3. Consome 1 análise (se aplicável ao perfil do usuário)
      await completeAnalysis(session, access);

      // Atualiza o perfil para manter o contador de análises sincronizado
      const updatedProf = await supaFetchProfile(session.access_token);
      if (updatedProf) {
        setProfile(updatedProf);
      }

      setResult(analysisRes);
      setView("result");
    } catch (e) {
      console.error("VALE?: erro durante a análise.", e);
      setFormError(
        e.message || "Erro ao consultar a FIPE. Tente novamente."
      );
      setView("form");
    }
  };

  const handleRestart = () => {
    setForm({
      brandId: "",
      brand: "",
      modelId: "",
      model: "",
      yearId: "",
      year: "",
      km: "",
      price: "",
    });
    setResult(null);
    setFormError("");

    if (!canStartAnalysis(access)) {
      setView("paywall");
    } else {
      setView("form");
    }
  };

  if (loading) {
    return (
      <div style={appContainerStyle}>
        <LoadingScreen />
      </div>
    );
  }

  if (!session) {
    return (
      <div style={appContainerStyle}>
        <AuthScreen
          onSignUp={handleSignUp}
          onSignIn={handleSignIn}
          onForgotPassword={handleForgotPassword}
        />
      </div>
    );
  }

  if (isResetFlow || view === "reset_password") {
    return (
      <div style={appContainerStyle}>
        <ResetPasswordScreen onUpdatePassword={handleUpdatePassword} />
      </div>
    );
  }

  return (
    <div style={appContainerStyle}>
      <header
        style={{
          padding: "16px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: `1px solid ${C.border}`,
          background: C.surface,
          zIndex: 10,
        }}
      >
        <Logo size={28} />
        <AccessBadge access={access} />
      </header>

      <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {view === "home" && (
          <HomeScreen
            onStart={handleStart}
            access={access}
            onLogout={handleLogout}
          />
        )}

        {view === "form" && (
          <FormScreen
            form={form}
            setForm={setForm}
            onSubmit={handleFormSubmit}
            onBack={() => setView("home")}
            accessToken={session.access_token}
            externalError={formError}
          />
        )}

        {view === "analyzing" && <AnalyzingScreen />}

        {view === "result" && result && (
          <ResultScreen
            result={result}
            onBack={() => setView("form")}
            onRestart={handleRestart}
          />
        )}

        {view === "paywall" && (
          <PaywallScreen
            onContinue={openCheckout}
            onDismiss={() => setView("home")}
          />
        )}
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600;700&family=Rajdhani:wght@600;700;800;900&display=swap');

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          padding: 0;
          background-color: ${C.bg};
          color: ${C.text};
          font-family: 'Inter', sans-serif;
          -webkit-font-smoothing: antialiased;
        }

        @keyframes vale-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes vale-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes vale-slide-in {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }

        @keyframes vale-toast-in {
          from { opacity: 0; transform: translate(-50%, 8px); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }

        /* Home responsive styles */
        .vale-home-page {
          overflow-y: auto;
        }
        .vale-home-wrap {
          max-width: 980px;
          margin: 0 auto;
          display: flex;
          flexDirection: column;
          gap: 32px;
        }
        .vale-home-hero {
          display: grid;
          grid-template-columns: 1.1fr 0.9fr;
          gap: 28px;
          align-items: center;
          padding: 24px 0 12px;
        }
        .vale-home-copy h1 {
          font-family: 'Rajdhani', sans-serif;
          font-size: 38px;
          font-weight: 800;
          line-height: 1.1;
          margin: 12px 0;
        }
        .vale-home-copy h1 span {
          color: ${C.gold};
        }
        .vale-home-kicker {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.5px;
          color: ${C.gold};
          text-transform: uppercase;
        }
        .vale-home-kicker-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: ${C.gold};
        }
        .vale-home-lead {
          font-size: 15px;
          color: ${C.muted};
          line-height: 1.6;
          margin: 0 0 24px;
        }
        .vale-home-hero-actions {
          display: flex;
          flex-direction: column;
          gap: 12px;
          max-width: 320px;
        }
        .vale-home-free-note {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          font-size: 12px;
          color: ${C.muted};
        }
        .vale-home-score-card {
          background: ${C.surfaceRaised};
          border: 1px solid ${C.border};
          border-radius: 20px;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.4);
        }
        .vale-home-score-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
        }
        .vale-home-score-top span {
          font-size: 10px;
          color: ${C.gold};
          font-weight: 700;
          letter-spacing: 1px;
        }
        .vale-home-score-top strong {
          display: block;
          font-size: 18px;
          font-family: 'Rajdhani', sans-serif;
          margin-top: 2px;
        }
        .vale-home-score-top small {
          color: ${C.muted};
          font-size: 12px;
        }
        .vale-home-score-badge {
          background: ${C.surfaceInput};
          border: 1px solid ${C.border};
          padding: 4px 8px;
          border-radius: 6px;
          font-size: 11px;
          font-weight: 700;
          color: ${C.faint};
        }
        .vale-home-score-main {
          display: flex;
          align-items: center;
          gap: 16px;
          background: ${C.surfaceInput};
          padding: 14px;
          border-radius: 14px;
        }
        .vale-home-mini-ring {
          width: 54px;
          height: 54px;
          border-radius: 50%;
          border: 3px solid ${C.green};
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          line-height: 1;
        }
        .vale-home-mini-ring span {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          font-size: 16px;
        }
        .vale-home-mini-ring small {
          font-size: 9px;
          color: ${C.muted};
        }
        .vale-home-good-pill {
          background: ${C.greenDim};
          color: ${C.green};
          font-size: 10px;
          font-weight: 700;
          padding: 3px 8px;
          border-radius: 99px;
          display: inline-block;
          margin-bottom: 4px;
        }
        .vale-home-score-info strong {
          display: block;
          font-size: 14px;
        }
        .vale-home-score-info p {
          margin: 2px 0 0;
          font-size: 12px;
          color: ${C.muted};
        }
        .vale-home-price-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 12px;
          border-top: 1px solid ${C.border};
          padding-top: 12px;
        }
        .vale-home-price-row span {
          display: block;
          color: ${C.faint};
          font-size: 10px;
        }
        .vale-home-price-row strong {
          font-family: 'JetBrains Mono', monospace;
          font-size: 14px;
        }
        .vale-home-price-arrow {
          color: ${C.green};
          font-weight: 700;
        }
        .vale-home-under-fipe {
          display: flex;
          align-items: center;
          gap: 6px;
          color: ${C.green};
          font-size: 12px;
        }

        .vale-home-trust {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
          background: ${C.surface};
          border: 1px solid ${C.border};
          border-radius: 16px;
          padding: 16px;
        }
        .vale-home-trust div {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          color: ${C.muted};
        }

        .vale-home-section-heading span {
          font-size: 11px;
          color: ${C.gold};
          font-weight: 700;
          letter-spacing: 1px;
        }
        .vale-home-section-heading h2 {
          font-family: 'Rajdhani', sans-serif;
          font-size: 24px;
          margin: 4px 0 16px;
        }

        .vale-home-steps {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 16px;
        }
        .vale-home-step {
          background: ${C.surfaceRaised};
          border: 1px solid ${C.border};
          padding: 18px;
          border-radius: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .vale-home-step span {
          font-family: 'JetBrains Mono', monospace;
          color: ${C.gold};
          font-size: 18px;
          font-weight: 700;
        }
        .vale-home-step strong {
          display: block;
          font-size: 15px;
          margin-bottom: 4px;
        }
        .vale-home-step p {
          margin: 0;
          font-size: 13px;
          color: ${C.muted};
          line-height: 1.4;
        }

        .vale-home-bottom {
          background: linear-gradient(135deg, ${C.surfaceRaised}, ${C.surface});
          border: 1px solid ${C.borderStrong};
          border-radius: 20px;
          padding: 24px;
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 24px;
          align-items: center;
        }
        .vale-home-bottom-copy h2 {
          font-family: 'Rajdhani', sans-serif;
          font-size: 26px;
          margin: 4px 0 8px;
        }
        .vale-home-bottom-copy p {
          margin: 0;
          color: ${C.muted};
          font-size: 14px;
        }
        .vale-home-bottom-card {
          background: ${C.surfaceInput};
          border: 1px solid ${C.border};
          padding: 16px;
          border-radius: 14px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-width: 200px;
          text-align: center;
        }
        .vale-home-bottom-card span {
          font-size: 10px;
          color: ${C.faint};
          letter-spacing: 1px;
        }
        .vale-home-bottom-card strong {
          display: block;
          font-size: 18px;
          color: ${C.gold};
        }
        .vale-home-bottom-card small {
          color: ${C.muted};
          font-size: 11px;
        }

        .vale-home-footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 12px;
          color: ${C.faint};
          border-top: 1px solid ${C.border};
          padding-top: 20px;
        }

        /* Result responsive layout grid */
        .vale-result-content {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .vale-result-top-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        .vale-result-bottom-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }

        @media (max-width: 768px) {
          .vale-home-hero {
            grid-template-columns: 1fr;
          }
          .vale-home-trust {
            grid-template-columns: 1fr;
          }
          .vale-home-steps {
            grid-template-columns: 1fr;
          }
          .vale-home-bottom {
            grid-template-columns: 1fr;
          }
          .vale-result-top-grid {
            grid-template-columns: 1fr;
          }
          .vale-result-bottom-grid {
            grid-template-columns: 1fr;
          }
          .vale-result-indicators {
            grid-template-columns: repeat(2, 1fr) !important;
          }
        }
      `}</style>
    </div>
  );
}

const appContainerStyle = {
  width: "100%",
  maxWidth: 1040,
  minHeight: "100vh",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  backgroundColor: C.bg,
  color: C.text,
  position: "relative",
  boxShadow: "0 0 50px rgba(0,0,0,0.5)",
};
