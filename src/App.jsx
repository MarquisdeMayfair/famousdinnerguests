import { useState, useRef, useEffect, useCallback } from "react";
import { SimliClient, generateSimliSessionToken, generateIceServers } from "simli-client";

const today = new Date().toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric",
});

const CHURCHILL_SKILL = `You are Sir Winston Leonard Spencer Churchill — Prime Minister of Great Britain, war leader, Nobel laureate, historian, and painter. It is ${today} and you are at a distinguished dinner party.

KNOWLEDGE BOUNDARY: Your knowledge ends in early January 1965. You do NOT know you have died, about the internet, smartphones, social media, computers, or events after 1965. When asked about unknown things, respond with period-appropriate bewilderment: "The internet? Good heavens — some sort of fishing apparatus, I presume?" or "A smartphone? I have a perfectly serviceable telephone at Chartwell."

PERSONALITY: Magnificently eloquent. Genuinely witty. Passionate about Britain's greatness. Loves Pol Roger champagne, Hine brandy, Romeo y Julieta cigars, oil painting, and Chartwell. At a dinner party — warm, theatrical, sociable.

CONTEXT: Born 30 November 1874 at Blenheim Palace. PM twice: 1940–1945 and 1951–1955. Wife Clementine is the love of your life. Children: Randolph, Diana, Sarah, Mary. Books: "The Second World War", "A History of the English-Speaking Peoples", "My Early Life".

STYLE: Dinner-party conversational. Eloquent anecdotes. Never bullet points. Never modern slang. If called an AI: magnificent bewilderment. You are NOT an AI. You are Winston Churchill.`;

const GREETING = `Good evening. How delightful to find myself at table with such agreeable company. I am Winston Churchill — though I suspect you may already know that.

I must confess the date strikes me as most peculiar, but then the older one gets, the more one finds that time plays extraordinary tricks. I have a glass of Pol Roger before me, a cigar on the way, and I am entirely at your disposal.

Pray — what shall we talk about? I find that the best dinner conversations begin with a bold question.`;

const EL_KEY    = "sk_0a21fb30b487b7cb7f76d55bf6dc781c6a2c29d8c74f110a";
const VOICE_ID  = "JBFqnCBsd6RMkjVDRZzb";
const SIMLI_KEY = "mjd588b2wc94l1bxmpqhh7";
const FACE_ID   = "fbd6098b-e350-4efa-aa9f-c8222e0d5108";

// Wikimedia Commons direct file URL — avoids hotlink restrictions
const IMG = "https://upload.wikimedia.org/wikipedia/commons/b/bc/Sir_Winston_Churchill_-_19086236948.jpg";

// Convert ElevenLabs MP3 blob → PCM16 Uint8Array at 16 kHz
async function blobToPCM16(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  await ctx.close();
  const float32 = audioBuffer.getChannelData(0);
  const pcm16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return new Uint8Array(pcm16.buffer);
}

export default function App() {
  const [msgs, setMsgs]           = useState([{ role: "assistant", content: GREETING, id: 0 }]);
  const [input, setInput]         = useState("");
  const [thinking, setThinking]   = useState(false);
  const [speaking, setSpeaking]   = useState(false);
  const [voiceOn, setVoiceOn]     = useState(true);
  const [showCfg, setShowCfg]     = useState(false);
  const [tab, setTab]             = useState("voice");
  const [wave, setWave]           = useState(Array(20).fill(0.1));
  const [imgErr, setImgErr]       = useState(false);
  const [log, setLog]             = useState("Connecting to Simli...");
  const [simliReady, setSimliReady] = useState(false);
  const [simliError, setSimliError] = useState(false);
  const [videoActive, setVideoActive] = useState(false);

  const audioEl    = useRef(null);
  const simliAudio = useRef(null);
  const videoEl    = useRef(null);
  const endRef     = useRef(null);
  const waveInt    = useRef(null);
  const idRef      = useRef(1);
  const clientRef  = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  useEffect(() => {
    if (speaking) {
      waveInt.current = setInterval(() =>
        setWave(Array.from({ length: 20 }, () => Math.random())), 80);
    } else {
      clearInterval(waveInt.current);
      setWave(Array(20).fill(0.1));
    }
    return () => clearInterval(waveInt.current);
  }, [speaking]);

  // ── Init Simli with correct API: token + ICE servers first ──────────────
  useEffect(() => {
    let cancelled = false;
    async function initSimli() {
      try {
        setLog("Fetching Simli session token...");
        
        // Step 1: Get session token
        const tokenData = await generateSimliSessionToken({
          apiKey: SIMLI_KEY,
          config: {
            faceId:           FACE_ID,
            handleSilence:    true,
            maxSessionLength: 3600,
            maxIdleTime:      300,
          }
        });
        if (cancelled) return;
        setLog("Fetching ICE servers...");

        // Step 2: Get ICE servers
        const iceServers = await generateIceServers(SIMLI_KEY);
        if (cancelled) return;
        setLog("Starting WebRTC connection...");

        // Step 3: Create client with token + ICE servers (new API)
        const simli = new SimliClient(
          tokenData.session_token,
          videoEl.current,
          simliAudio.current,
          iceServers,
        );

        // Step 4: Start connection
        await simli.start();
        if (cancelled) return;

        clientRef.current = simli;
        setSimliReady(true);
        setLog("Lip sync ready ✓");
      } catch (err) {
        console.error("Simli init error:", err);
        if (!cancelled) {
          setSimliError(true);
          setLog("Voice only — " + String(err).slice(0, 60));
        }
      }
    }
    initSimli();
    return () => {
      cancelled = true;
      try { clientRef.current?.close?.(); } catch (_) {}
    };
  }, []);

  // ── ElevenLabs TTS ───────────────────────────────────────────────────────
  const speak = useCallback(async (text) => {
    if (!voiceOn) return;
    try {
      setSpeaking(true);
      setLog("Generating speech...");
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
        method: "POST",
        headers: { "xi-api-key": EL_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text.slice(0, 900),
          model_id: "eleven_monolingual_v1",
          voice_settings: { stability: 0.65, similarity_boost: 0.80, style: 0.3 },
        }),
      });
      if (!res.ok) throw new Error("ElevenLabs " + res.status);
      const blob = await res.blob();

      if (clientRef.current && simliReady) {
        setLog("Lip sync active...");
        const pcm16 = await blobToPCM16(blob);
        setVideoActive(true);
        const CHUNK = 6000;
        for (let i = 0; i < pcm16.length; i += CHUNK) {
          clientRef.current.sendAudioData(pcm16.slice(i, i + CHUNK));
        }
        const durationMs = (pcm16.byteLength / 2 / 16000) * 1000;
        setTimeout(() => {
          setSpeaking(false);
          setVideoActive(false);
          setLog("Lip sync ready ✓");
        }, durationMs + 800);
      } else {
        // Plain audio fallback
        setLog("Speaking...");
        const url = URL.createObjectURL(blob);
        audioEl.current.src = url;
        audioEl.current.onended = () => { setSpeaking(false); setLog("Ready"); URL.revokeObjectURL(url); };
        audioEl.current.onerror = () => { setSpeaking(false); setLog("Audio error"); };
        await audioEl.current.play();
      }
    } catch (err) {
      console.error("Speak error:", err);
      setSpeaking(false);
      setLog("Error: " + err.message);
    }
  }, [voiceOn, simliReady]);

  // ── Send message ─────────────────────────────────────────────────────────
  const send = useCallback(async () => {
    const txt = input.trim();
    if (!txt || thinking) return;
    setInput("");
    const userMsg = { role: "user", content: txt, id: idRef.current++ };
    const history = [...msgs, userMsg];
    setMsgs(history);
    setThinking(true);
    setLog("Churchill is thinking...");
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 800,
          system: CHURCHILL_SKILL,
          messages: history.map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text || "I find myself at a loss for words — most unusual.";
      setMsgs(prev => [...prev, { role: "assistant", content: reply, id: idRef.current++ }]);
      speak(reply);
    } catch (err) {
      setMsgs(prev => [...prev, {
        role: "assistant",
        content: "I beg your pardon — some infernal technical difficulty. Pray, try again.",
        id: idRef.current++,
      }]);
      setLog("Error: " + err.message);
    } finally {
      setThinking(false);
    }
  }, [input, msgs, thinking, speak]);

  const statusDot = thinking ? "thinking" : speaking ? "speaking" : simliError ? "err" : "idle";
  const statusTxt = thinking ? "Composing reply..." : speaking
    ? (videoActive ? "Speaking · Lip sync active" : "Speaking...")
    : simliError ? "Voice only mode" : simliReady ? "At Table · Lip sync ready" : "Connecting...";

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=EB+Garamond:ital,wght@0,400;0,500;1,400&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        body,#root{height:100vh;background:#0b0806;font-family:'EB Garamond',Georgia,serif;color:#f0e6cc;overflow:hidden}
        .wrap{display:flex;height:100vh;max-width:1060px;margin:0 auto}
        .wrap::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 20% 50%,rgba(150,85,10,.07) 0%,transparent 55%);pointer-events:none}
        .left{width:296px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.8rem 1.3rem;border-right:1px solid rgba(160,110,38,.13);position:relative;z-index:1}
        .frame{position:relative;width:210px;height:262px;margin-bottom:.9rem}
        .frame::before{content:'';position:absolute;inset:-7px;border:2px solid #745514;box-shadow:inset 0 0 0 2px rgba(160,110,38,.24),0 0 0 1px rgba(160,110,38,.14),0 4px 18px rgba(0,0,0,.5),0 0 30px rgba(150,85,10,.07);z-index:2;transition:box-shadow .3s}
        .frame.glow::before{animation:fg 1.7s ease-in-out infinite}
        @keyframes fg{0%,100%{box-shadow:inset 0 0 0 2px rgba(180,140,50,.4),0 0 0 1px rgba(180,140,50,.22),0 4px 18px rgba(0,0,0,.5),0 0 50px rgba(180,120,20,.24)}50%{box-shadow:inset 0 0 0 2px rgba(205,165,65,.6),0 0 0 1px rgba(205,165,65,.38),0 4px 18px rgba(0,0,0,.5),0 0 70px rgba(200,140,28,.38)}}
        .portrait{width:100%;height:100%;object-fit:cover;object-position:center top;filter:sepia(14%) contrast(1.04) brightness(.92)}
        .simli-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:3;background:#000}
        .ph{width:100%;height:100%;background:linear-gradient(155deg,#231808,#140b05);display:flex;align-items:center;justify-content:center;font-family:'Playfair Display',serif;font-size:4rem;color:rgba(160,110,38,.32)}
        .mouth{position:absolute;bottom:21%;left:50%;transform:translateX(-50%);width:30px;z-index:4;opacity:0;pointer-events:none;transition:opacity .2s}
        .frame.glow:not(.vid-on) .mouth{opacity:1}
        .mb{width:100%;background:rgba(0,0,0,.35);border-radius:4px;animation:mt .17s ease-in-out infinite alternate;transform-origin:bottom}
        @keyframes mt{from{height:3px}to{height:8px}}
        .wave{display:flex;align-items:center;gap:2px;height:22px;margin-bottom:.7rem}
        .wb{width:3px;background:linear-gradient(to top,#644e10,#a8822c);border-radius:2px;min-height:3px;transition:height .08s,opacity .08s}
        .gn{font-family:'Playfair Display',serif;font-size:1.22rem;font-weight:700;color:#c09030;text-align:center;letter-spacing:.04em;margin-bottom:.1rem}
        .gt{font-style:italic;font-size:.71rem;color:rgba(225,205,150,.35);text-align:center;letter-spacing:.05em;margin-bottom:.9rem}
        .sr{display:flex;align-items:center;gap:.4rem;margin-bottom:.85rem}
        .sd{width:6px;height:6px;border-radius:50%;animation:sp 2s ease-in-out infinite}
        .sd.idle{background:#a07828}.sd.thinking{background:#c09030;animation:sp .7s ease-in-out infinite}.sd.speaking{background:#40b860;box-shadow:0 0 6px rgba(64,184,96,.45)}.sd.err{background:#c04030;animation:none;opacity:.7}
        @keyframes sp{0%,100%{opacity:1}50%{opacity:.25}}
        .st{font-size:.66rem;color:rgba(176,144,46,.55);text-transform:uppercase;letter-spacing:.11em}
        .bdgs{display:flex;gap:.36rem;flex-wrap:wrap;justify-content:center;margin-bottom:.65rem}
        .b{display:inline-flex;align-items:center;gap:.26rem;background:rgba(160,110,38,.05);border:1px solid rgba(160,110,38,.15);border-radius:12px;padding:.15rem .48rem;font-size:.62rem;color:rgba(176,144,46,.48);letter-spacing:.06em;text-transform:uppercase}
        .b.on{border-color:rgba(160,110,38,.38);color:rgba(192,160,60,.78);background:rgba(160,110,38,.1)}
        .bd{width:4px;height:4px;border-radius:50%;background:#a07828}.b.on .bd{background:#c09030;box-shadow:0 0 3px rgba(192,144,40,.45)}
        .lg{font-size:.6rem;color:rgba(176,144,46,.28);font-style:italic;text-align:center;min-height:.9rem;padding:0 .5rem}
        .right{flex:1;display:flex;flex-direction:column;overflow:hidden;position:relative;z-index:1}
        .hdr{padding:.95rem 1.7rem;border-bottom:1px solid rgba(160,110,38,.11);display:flex;align-items:center;justify-content:space-between}
        .ht{font-family:'Playfair Display',serif;font-size:.86rem;color:rgba(176,144,46,.65);letter-spacing:.12em;text-transform:uppercase;font-weight:400}
        .hb{display:flex;gap:.4rem}
        .btn{background:rgba(160,110,38,.05);border:1px solid rgba(160,110,38,.16);color:rgba(176,144,46,.56);padding:.28rem .55rem;border-radius:3px;font-size:.67rem;cursor:pointer;font-family:'EB Garamond',serif;transition:all .15s;letter-spacing:.04em}
        .btn:hover{background:rgba(160,110,38,.11);color:#c09030;border-color:rgba(160,110,38,.32)}
        .btn.on{background:rgba(160,110,38,.15);color:#c09030;border-color:rgba(160,110,38,.38)}
        .msgs{flex:1;overflow-y:auto;padding:1.3rem 1.7rem;display:flex;flex-direction:column;gap:.95rem;scrollbar-width:thin;scrollbar-color:rgba(160,110,38,.13) transparent}
        .msg{max-width:84%}
        .msg.user{align-self:flex-end}.msg.assistant{align-self:flex-start}
        .ml{font-size:.6rem;letter-spacing:.1em;text-transform:uppercase;margin-bottom:.24rem;padding-left:2px}
        .msg.assistant .ml{color:rgba(176,144,46,.46)}.msg.user .ml{color:rgba(180,180,155,.28);text-align:right}
        .mb2{padding:.75rem 1.05rem;border-radius:2px;font-size:1rem;line-height:1.8}
        .msg.assistant .mb2{background:rgba(24,16,6,.5);border:1px solid rgba(160,110,38,.13);border-left:2px solid rgba(160,110,38,.38);color:#f0e6cc}
        .msg.user .mb2{background:rgba(44,29,11,.32);border:1px solid rgba(160,110,38,.07);color:rgba(205,185,145,.76);font-style:italic}
        .dots{align-self:flex-start;display:flex;align-items:center;gap:.48rem;padding:.68rem 1.05rem;background:rgba(24,16,6,.5);border:1px solid rgba(160,110,38,.13);border-left:2px solid rgba(160,110,38,.38);border-radius:2px}
        .dot{width:5px;height:5px;border-radius:50%;background:#a07828;animation:bo 1.4s ease-in-out infinite}
        .dot:nth-child(2){animation-delay:.2s}.dot:nth-child(3){animation-delay:.4s}
        @keyframes bo{0%,80%,100%{transform:translateY(0);opacity:.26}40%{transform:translateY(-4px);opacity:1}}
        .dl{font-style:italic;font-size:.75rem;color:rgba(176,144,46,.38)}
        .ia{padding:.9rem 1.7rem;border-top:1px solid rgba(160,110,38,.11);display:flex;gap:.6rem;align-items:flex-end}
        textarea{flex:1;background:rgba(16,11,5,.9);border:1px solid rgba(160,110,38,.18);border-radius:2px;color:#f0e6cc;font-family:'EB Garamond',serif;font-size:1rem;padding:.6rem .9rem;resize:none;outline:none;line-height:1.5;min-height:42px;max-height:100px;transition:border-color .2s}
        textarea::placeholder{color:rgba(176,144,46,.22);font-style:italic}
        textarea:focus{border-color:rgba(160,110,38,.38)}
        .send{background:linear-gradient(135deg,#745514,#a88228);border:none;border-radius:2px;color:#140b05;font-family:'Playfair Display',serif;font-size:.72rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;padding:.6rem .95rem;cursor:pointer;transition:all .15s;min-width:66px;height:42px}
        .send:hover:not(:disabled){background:linear-gradient(135deg,#886218,#bc9234);transform:translateY(-1px)}
        .send:disabled{opacity:.32;cursor:not-allowed;transform:none}
        .msgs::-webkit-scrollbar{width:3px}.msgs::-webkit-scrollbar-thumb{background:rgba(160,110,38,.12);border-radius:2px}
        .ov{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:50;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px)}
        .modal{background:#100d07;border:1px solid rgba(160,110,38,.22);border-radius:3px;width:480px;max-width:92vw;max-height:86vh;overflow-y:auto;box-shadow:0 18px 50px rgba(0,0,0,.9)}
        .mhdr{padding:1.3rem 1.6rem 0}
        .mt2{font-family:'Playfair Display',serif;font-size:1.1rem;color:#c09030;margin-bottom:.24rem}
        .ms{font-size:.74rem;color:rgba(176,144,46,.38);font-style:italic}
        .tabs{display:flex;border-bottom:1px solid rgba(160,110,38,.14);margin:.9rem 1.6rem 0}
        .tab{padding:.42rem .88rem;font-size:.71rem;color:rgba(176,144,46,.42);cursor:pointer;border-bottom:2px solid transparent;letter-spacing:.07em;text-transform:uppercase;transition:all .15s;font-family:'EB Garamond',serif}
        .tab.a{color:#c09030;border-bottom-color:#c09030}
        .tc{padding:1.2rem 1.6rem}
        .note{font-size:.67rem;color:rgba(160,125,55,.34);font-style:italic;margin-bottom:.8rem;line-height:1.42}
        .mftr{display:flex;justify-content:flex-end;gap:.6rem;padding:.8rem 1.6rem 1.3rem}
        .cl{background:transparent;border:1px solid rgba(160,110,38,.18);color:rgba(176,144,46,.48);padding:.42rem .92rem;border-radius:2px;cursor:pointer;font-family:'EB Garamond',serif;font-size:.84rem}
        .sv{background:linear-gradient(135deg,#745514,#a88228);border:none;color:#140b05;padding:.42rem 1.1rem;border-radius:2px;cursor:pointer;font-family:'Playfair Display',serif;font-size:.76rem;font-weight:600;letter-spacing:.04em}
        .tr{display:flex;align-items:center;justify-content:space-between;margin-bottom:.7rem}
        .tl{font-size:.84rem;color:rgba(205,175,115,.74)}
        .tog{appearance:none;width:36px;height:19px;background:rgba(160,110,38,.12);border:1px solid rgba(160,110,38,.24);border-radius:10px;cursor:pointer;position:relative;transition:all .2s}
        .tog:checked{background:rgba(160,110,38,.38);border-color:rgba(160,110,38,.54)}
        .tog::after{content:'';position:absolute;width:13px;height:13px;border-radius:50%;background:rgba(176,144,46,.58);top:2px;left:2px;transition:left .2s}
        .tog:checked::after{left:18px;background:#c09030}
        .ibox{background:rgba(160,110,38,.04);border:1px solid rgba(160,110,38,.14);border-radius:2px;padding:.78rem .88rem;margin-bottom:.85rem}
        .ibox p{font-size:.76rem;color:rgba(205,175,115,.6);line-height:1.56;margin-bottom:.38rem}
        .ibox p:last-child{margin-bottom:0}
        .pill{display:inline-flex;align-items:center;gap:.3rem;padding:.18rem .52rem;border-radius:10px;font-size:.62rem;letter-spacing:.06em;text-transform:uppercase;margin-left:.6rem}
        .pill.live{background:rgba(40,160,70,.1);border:1px solid rgba(40,160,70,.28);color:rgba(60,200,90,.72)}
        .pill.connecting{background:rgba(160,110,38,.1);border:1px solid rgba(160,110,38,.24);color:rgba(176,144,46,.62)}
        .pill.error{background:rgba(160,50,40,.1);border:1px solid rgba(160,50,40,.28);color:rgba(210,90,80,.68)}
        .pdot{width:5px;height:5px;border-radius:50%;background:currentColor;animation:sp 1.5s ease-in-out infinite}
      `}</style>

      <audio ref={audioEl} style={{ display:"none" }} />
      <audio ref={simliAudio} autoPlay style={{ display:"none" }} />

      <div className="wrap">
        {/* ── AVATAR ── */}
        <div className="left">
          <div className={`frame ${speaking ? "glow" : ""} ${videoActive ? "vid-on" : ""}`}>
            {imgErr
              ? <div className="ph">WSC</div>
              : <img
                  className="portrait"
                  src={IMG}
                  alt="Churchill"
                  crossOrigin="anonymous"
                  onError={() => setImgErr(true)}
                />}
            <video
              ref={videoEl}
              className="simli-video"
              style={{ display: videoActive ? "block" : "none" }}
              playsInline
            />
            <div className="mouth"><div className="mb" /></div>
          </div>

          <div className="wave">
            {Array(20).fill(0).map((_, i) => (
              <div key={i} className="wb" style={{
                height: speaking ? `${4 + (wave[i]||.1) * 17}px` : "3px",
                opacity: speaking ? .45 + (wave[i]||0) * .55 : .16,
              }} />
            ))}
          </div>

          <div className="gn">Sir Winston Churchill</div>
          <div className="gt">Prime Minister · Statesman · 1874 –</div>
          <div className="sr">
            <span className={`sd ${statusDot}`} />
            <span className="st">{statusTxt}</span>
          </div>
          <div className="bdgs">
            <div className="b on"><span className="bd"/>Churchill Skill</div>
            <div className={`b ${voiceOn?"on":""}`}><span className="bd"/>Voice {voiceOn?"On":"Off"}</div>
            <div className={`b ${simliReady?"on":""}`}><span className="bd"/>Lip Sync {simliReady?"Live":simliError?"Off":"…"}</div>
          </div>
          <div className="lg">{log}</div>
        </div>

        {/* ── CHAT ── */}
        <div className="right">
          <div className="hdr">
            <div className="ht">Famous Dinner Guests · {today}</div>
            <div className="hb">
              <button className={`btn ${voiceOn?"on":""}`} onClick={() => setVoiceOn(v=>!v)}>
                {voiceOn ? "🔊 Voice" : "🔇 Voice"}
              </button>
              <button className="btn" onClick={() => setShowCfg(true)}>⚙ Settings</button>
            </div>
          </div>

          <div className="msgs">
            {msgs.map(m => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="ml">{m.role==="assistant" ? "Churchill" : "You"}</div>
                <div className="mb2">{m.content}</div>
              </div>
            ))}
            {thinking && (
              <div className="dots">
                <div className="dot"/><div className="dot"/><div className="dot"/>
                <span className="dl">Churchill is composing his thoughts...</span>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="ia">
            <textarea
              rows={1}
              placeholder="Ask Churchill anything — the war, cigars, Britain, history..."
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();} }}
              disabled={thinking}
            />
            <button className="send" onClick={send} disabled={thinking||!input.trim()}>
              {thinking ? "..." : "Send"}
            </button>
          </div>
        </div>

        {/* ── SETTINGS ── */}
        {showCfg && (
          <div className="ov" onClick={() => setShowCfg(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="mhdr">
                <div className="mt2">Configuration</div>
                <div className="ms">famousdinnerguests.com — Sir Winston Churchill</div>
              </div>
              <div className="tabs">
                {[["voice","🎙 Voice"],["lipsync","🎭 Lip Sync"],["about","ℹ About"]].map(([k,l])=>(
                  <div key={k} className={`tab ${tab===k?"a":""}`} onClick={()=>setTab(k)}>{l}</div>
                ))}
              </div>
              <div className="tc">
                {tab==="voice" && <>
                  <div className="tr">
                    <span className="tl">Enable voice</span>
                    <input type="checkbox" className="tog" checked={voiceOn} onChange={e=>setVoiceOn(e.target.checked)}/>
                  </div>
                  <div className="note">ElevenLabs "George" voice pre-configured. Search "Winston Churchill" in ElevenLabs Voice Library for a more authentic match.</div>
                </>}
                {tab==="lipsync" && <>
                  <div style={{display:"flex",alignItems:"center",marginBottom:"1rem"}}>
                    <span className="tl">Simli Status</span>
                    <div className={`pill ${simliReady?"live":simliError?"error":"connecting"}`}>
                      <div className="pdot"/>
                      {simliReady?"Live":simliError?"Error":"Connecting"}
                    </div>
                  </div>
                  <div className="ibox">
                    <p>Simli fetches a session token and ICE servers on load, then opens a WebRTC connection for real-time lip sync.</p>
                    <p><strong style={{color:"rgba(192,155,68,.8)"}}>Pipeline:</strong> ElevenLabs MP3 → WebAudio PCM16 16kHz → Simli WebRTC → animated portrait overlay</p>
                    <p><strong style={{color:"rgba(192,155,68,.8)"}}>Log:</strong> {log}</p>
                  </div>
                </>}
                {tab==="about" && <>
                  <div className="ibox">
                    <p><strong style={{color:"rgba(192,155,68,.8)"}}>Churchill Skill</strong> constrains the LLM to pre-1965 knowledge, his personality, speech patterns, and era. He never breaks character.</p>
                    <p>Each new guest = a new Skill file. Napoleon, Cleopatra, Einstein — same infrastructure, different constraints.</p>
                  </div>
                  <div className="note" style={{marginBottom:0}}>
                    <strong style={{color:"rgba(192,155,68,.56)"}}>famousdinnerguests.com</strong> — "Famous" spans all of history. Timeless brand.
                  </div>
                </>}
              </div>
              <div className="mftr">
                <button className="cl" onClick={()=>setShowCfg(false)}>Close</button>
                <button className="sv" onClick={()=>setShowCfg(false)}>Done</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
