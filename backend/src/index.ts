import path from "path";
import { ReviewSyncService } from "./services/reviewSyncService";
import { scheduleGoogleReviewSync } from "./jobs/syncGoogleReviews";
import { resolvePlaceIdFromText } from "./services/placeResolver";
import { WidgetStore } from "./services/widgetStore";
import { prisma } from "./lib/prisma";

// Railway/Vercel: process.env.XYZ tự có, không cần dotenv
const express = require("express");
const cors = require("cors");
const projectRoot = process.cwd().endsWith("backend")
  ? path.resolve(process.cwd(), "..")
  : process.cwd();

const app = express();
// CORS: Allow all origins for widget embedding
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve widget static files
const embedDistPath = path.join(projectRoot, "frontend", "embed", "dist");
const embedSrcPath = path.join(projectRoot, "frontend", "embed");

// Serve widget.js (compiled from TypeScript)
app.get("/widget.js", (_req: any, res: any) => {
  // Set headers for widget embedding
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(embedDistPath, "widget.js"), (err: any) => {
    if (err) {
      console.error("Failed to serve widget.js:", err);
      res.status(404).send("Widget file not found. Please build the widget first: cd frontend/embed && npm run build");
    }
  });
});

// Serve embed.js (loader script)
app.get("/embed.js", (_req: any, res: any) => {
  // Set headers for widget embedding
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(path.join(embedSrcPath, "embed.js"), (err: any) => {
    if (err) {
      console.error("Failed to serve embed.js:", err);
      res.status(404).send("Embed file not found");
    }
  });
});

// Railway sets PORT automatically via process.env.PORT
const PORT = process.env.PORT ? Number(process.env.PORT) : (process.env.NODE_ENV === "production" ? 8080 : 5001);
const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  console.warn("Warning: GOOGLE_API_KEY is missing. API calls will fail.");
}

const widgetStore = new WidgetStore();

// Optional: default place sync if env is provided (for your own site)
// This is now discouraged in SaaS mode but kept for backward compatibility if specifically configured
const defaultPlaceId = process.env.GOOGLE_PLACE_ID;
// Note: Manual background sync for "default" place is complicated with widgetId. 
// We should probably rely on widget-specific syncs.


// Legacy single-place endpoints (optional)
app.post("/api/reviews/sync", async (_req: any, res: any) => {
  if (!defaultPlaceId) {
    return res.status(400).json({ error: "GOOGLE_PLACE_ID not configured" });
  }
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }
  try {
    const service = new ReviewSyncService(defaultPlaceId, apiKey, "default");
    const result = await service.sync();

    res.json({ message: "sync completed", ...result });
  } catch (error) {
    console.error("Manual sync failed:", error);
    res.status(500).json({ error: "sync failed" });
  }
});

app.get("/api/reviews/summary", async (_req: any, res: any) => {
  if (!defaultPlaceId) {
    return res.status(400).json({ error: "GOOGLE_PLACE_ID not configured" });
  }
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }
  try {
    const service = new ReviewSyncService(defaultPlaceId, apiKey, "default");
    const summary = await service.getSummary();

    if (!summary) {
      return res.status(404).json({ error: "no summary yet. trigger sync first" });
    }
    return res.json(summary);
  } catch (error) {
    console.error("Failed to load summary:", error);
    return res.status(500).json({ error: "could not load summary" });
  }
});

// --- Multi-widget endpoints ---

app.get("/api/widgets", async (_req: any, res: any) => {
  try {
    const widgets = await prisma.widget.findMany({
      orderBy: { createdAt: "desc" },
    });
    return res.json({ widgets });
  } catch (error) {
    console.error("List widgets failed:", error);
    return res.status(500).json({ error: "failed to list widgets" });
  }
});
app.get("/api/widgets/:id", async (req: any, res: any) => {
  try {
    const widget = await widgetStore.get(req.params.id);
    if (!widget) return res.status(404).json({ error: "widget not found" });
    return res.json({ widget });
  } catch (error) {
    console.error("Get widget failed:", error);
    return res.status(500).json({ error: "failed to get widget" });
  }
});

app.get("/api/places/search", async (req: any, res: any) => {

  const q = String(req.query.q ?? "").trim();
  if (!q) {
    return res.status(400).json({ error: "missing q" });
  }
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }

  try {
    const results = await resolvePlaceIdFromText(q, apiKey);
    return res.json({ results: results ?? [] });
  } catch (error) {
    console.error("Place search failed:", error);
    return res.status(500).json({ error: "failed to search places" });
  }
});

app.post("/api/widgets", async (req: any, res: any) => {
  const { query, title, theme } = req.body ?? {};
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "missing query" });
  }
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }

  try {
    console.log(`[POST /api/widgets] Searching for: "${query}"`);
    console.log(`[POST /api/widgets] API Key present: ${apiKey ? 'YES' : 'NO'}`);
    const candidates = await resolvePlaceIdFromText(query, apiKey);
    if (!candidates || !candidates.length) {
      console.log(`[POST /api/widgets] No places found for: "${query}"`);
      return res.status(404).json({
        error: "no place found",
        query,
        hint: "Thử nhập địa chỉ đầy đủ hơn (ví dụ: 'Starbucks New York' thay vì URL Google Maps). Nếu vẫn lỗi, kiểm tra Google API key có được set trên Railway và có bật Places API (New) chưa."
      });
    }

    console.log(`[POST /api/widgets] Found ${candidates.length} candidate(s)`);
    const primary = candidates[0];
    const widget = await widgetStore.create({
      placeId: primary.placeId,
      businessName: primary.name,
      title: title || primary.name,
      settings: req.body.settings
    });

    // --- Auto-sync initial reviews on creation ---
    try {
      console.log(`[POST /api/widgets] Initializing auto-sync for widget: ${widget.id}`);
      const syncService = new ReviewSyncService(widget.placeId, apiKey, widget.id);
      await syncService.sync();
      console.log(`[POST /api/widgets] Auto-sync completed for: ${widget.id}`);
    } catch (syncError) {
      console.error("[POST /api/widgets] Initial sync failed (will retry in background):", syncError);
    }

    const backendBase = process.env.NEXT_PUBLIC_WIDGET_BASE_URL ?? `http://localhost:${PORT}`;
    const embedCode = `
<div id="google-reviews-widget"></div>
<script src="${backendBase}/widget.js" async></script>
<script
  defer
  src="${backendBase}/embed.js"
  data-container-id="google-reviews-widget"
  data-backend="${backendBase}"
  data-widget-id="${widget.id}">
</script>`.trim();

    return res.json({ widget, embedCode, candidates });
  } catch (error: any) {
    console.error("Create widget failed:", error);
    const message = error?.message || "failed to create widget";
    // Provide more helpful error messages
    let hint = "";
    if (message.includes("Places API (New) chưa được bật") || message.includes("API_KEY_SERVICE_BLOCKED")) {
      hint = "Vui lòng: 1) Vào Google Cloud Console → APIs & Services → Library → bật 'Places API (New)'. 2) Kiểm tra API key có bị restrict quá chặt không.";
    } else if (message.includes("GOOGLE_API_KEY not configured") || !apiKey) {
      hint = "GOOGLE_API_KEY chưa được set trên Railway. Vào Railway → Service → Variables → thêm GOOGLE_API_KEY.";
    } else if (message.includes("403") || message.includes("PERMISSION_DENIED")) {
      hint = "API key không có quyền truy cập Places API (New). Kiểm tra Google Cloud Console → APIs & Services → Credentials → API key restrictions.";
    }
    return res.status(500).json({
      error: message,
      details: String(error),
      hint: hint || "Kiểm tra Railway logs để xem lỗi chi tiết."
    });
  }
});

app.patch("/api/widgets/:id", async (req: any, res: any) => {
  const widgetId = req.params.id;
  const { title, settings } = req.body;
  try {
    const widget = await widgetStore.update(widgetId, { title, settings });
    return res.json({ widget });
  } catch (error) {
    console.error("Update widget failed:", error);
    return res.status(500).json({ error: "failed to update widget" });
  }
});


app.post("/api/widgets/:id/sync", async (req: any, res: any) => {
  const widgetId = req.params.id;
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }
  try {
    const widget = await widgetStore.get(widgetId);
    if (!widget) {
      return res.status(404).json({ error: "widget not found" });
    }
    const service = new ReviewSyncService(widget.placeId, apiKey, widgetId);
    const result = await service.sync();

    return res.json({ message: "sync completed", ...result });
  } catch (error) {
    console.error("Widget sync failed:", error);
    return res.status(500).json({ error: "sync failed" });
  }
});

app.get("/api/widgets/:id/summary", async (req: any, res: any) => {
  const widgetId = req.params.id;
  if (!apiKey) {
    return res.status(400).json({ error: "GOOGLE_API_KEY not configured" });
  }
  try {
    const widget = await widgetStore.get(widgetId);
    if (!widget) {
      return res.status(404).json({ error: "widget not found" });
    }
    const service = new ReviewSyncService(widget.placeId, apiKey, widgetId);
    const summary = await service.getSummary(widget.settings);

    if (!summary) {
      return res.status(404).json({ error: "no summary yet. trigger sync first" });
    }
    return res.json(summary);
  } catch (error) {
    console.error("Widget summary failed:", error);
    return res.status(500).json({ error: "could not load summary" });
  }
});

// Intermediate page to show Google Reviews link (bypasses CSP/iframe blocking)
app.get("/api/redirect/google-reviews", async (req: any, res: any) => {
  const placeId = req.query.placeId as string;
  const businessName = req.query.business as string;

  if (!placeId) {
    return res.status(400).json({ error: "placeId is required" });
  }

  // Use official Local Review URLs for best experience
  // Write review: https://search.google.com/local/writereview?placeid=...
  // View reviews: https://search.google.com/local/reviews?placeid=...

  const type = req.query.type as string;
  let googleUrl = "";

  if (placeId) {
    if (type === "write") {
      googleUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;
    } else {
      // Use the ultra-stable local reviews page URL
      googleUrl = `https://search.google.com/local/reviews?placeid=${placeId}`;
    }
  } else {
    // Fallback to Google Maps search with query
    googleUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent((businessName || 'Business') + ' reviews')}`;
  }

  // Set security headers to bypass browser blocks
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <meta name="referrer" content="no-referrer">
      <title>View Reviews on Google</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          display: flex;
          justify-content: center;
          align-items: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #333;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 16px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
          text-align: center;
          max-width: 450px;
          width: 90%;
        }
        h1 { color: #1a73e8; font-size: 24px; margin: 0 0 10px 0; }
        p { color: #5f6368; line-height: 1.5; margin-bottom: 30px; }
        .button {
          display: inline-block;
          background-color: #1a73e8;
          color: white;
          padding: 14px 32px;
          border-radius: 8px;
          text-decoration: none;
          font-weight: 600;
          font-size: 16px;
          cursor: pointer;
          border: none;
        }
        .loader {
          width: 48px;
          height: 48px;
          border: 4px solid #f3f3f3;
          border-top: 4px solid #1a73e8;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin: 0 auto 20px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="loader"></div>
        <h1>🔍 View Reviews on Google</h1>
        <p>Redirecting you to view reviews for <strong>${businessName || 'this business'}</strong>.</p>
        
        <a href="${googleUrl}" target="_top" rel="noreferrer" class="button">Continue to Google Reviews</a>
        
        <script>
          // Instant direct navigation to bypass security flags
          setTimeout(function() {
            try {
              if (window.top) {
                window.top.location.replace("${googleUrl}");
              } else {
                window.location.replace("${googleUrl}");
              }
            } catch (e) {
              window.location.replace("${googleUrl}");
            }
          }, 500);
        </script>
      </div>
    </body>
    </html>
  `);
});

app.get("/api/health", (_req: any, res: any) => {
  res.json({ status: "ok", service: "google-reviews-widget" });
});

// Scheduled sync job for all widgets (runs daily at 2 AM UTC)
async function syncAllWidgets() {
  if (!apiKey) {
    console.warn("[Scheduled Sync] Skipping: GOOGLE_API_KEY not configured");
    return;
  }

  try {
    console.log("[Scheduled Sync] Starting sync for all widgets...");
    const widgets = await widgetStore.list();
    console.log(`[Scheduled Sync] Found ${widgets.length} widget(s) to sync`);

    for (const widget of widgets) {
      try {
        console.log(`[Scheduled Sync] Syncing widget: ${widget.id} (${widget.businessName || widget.title})`);
        const service = new ReviewSyncService(widget.placeId, apiKey, widget.id);
        await service.sync();
        console.log(`[Scheduled Sync] Completed: ${widget.id}`);
        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error(`[Scheduled Sync] Failed for widget ${widget.id}:`, error);
      }
    }
    console.log("[Scheduled Sync] All widgets synced");
  } catch (error) {
    console.error("[Scheduled Sync] Error:", error);
  }
}

// Schedule daily sync at 2 AM UTC (can be overridden with OVERRIDE_SYNC_CRON env var)
if (!process.env.VERCEL) {
  const cron = require("node-cron");
  const syncCronExpression = process.env.OVERRIDE_SYNC_CRON || "0 2 * * *"; // Daily at 2 AM UTC
  if (cron.validate(syncCronExpression)) {
    cron.schedule(syncCronExpression, syncAllWidgets, {
      scheduled: true,
      timezone: "UTC"
    });
    console.log(`[Scheduled Sync] Configured with cron: ${syncCronExpression} (Daily at 2 AM UTC)`);
  } else {
    console.warn(`[Scheduled Sync] Invalid cron expression: ${syncCronExpression}`);
  }
}

// Start server - Always start for Railway/production
// Only skip if explicitly on Vercel (serverless)
if (!process.env.VERCEL) {
  const serverPort = process.env.PORT || PORT;
  app.listen(serverPort, "0.0.0.0", () => {
    console.log(`Backend listening on port ${serverPort}`);
    console.log(`Health check: http://0.0.0.0:${serverPort}/api/health`);
  });
}

export default app;

