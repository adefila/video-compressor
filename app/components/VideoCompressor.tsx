"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { zipSync } from "fflate";

const CORE_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
const SETTINGS_KEY = "video-compressor:settings";

const QUALITY_PRESETS = {
  high: { label: "High quality", crf: 23 },
  medium: { label: "Balanced", crf: 28 },
  low: { label: "Smallest size", crf: 34 },
} as const;

type QualityKey = keyof typeof QUALITY_PRESETS;

const RESOLUTIONS = {
  original: { label: "Original", scale: null },
  "1080": { label: "1080p", scale: "1920:-2" },
  "720": { label: "720p", scale: "1280:-2" },
  "480": { label: "480p", scale: "854:-2" },
} as const;

type ResolutionKey = keyof typeof RESOLUTIONS;

type SizeMode = "quality" | "targetSize";

type QueueStatus = "queued" | "compressing" | "done" | "error";

type QueueItem = {
  id: string;
  file: File;
  status: QueueStatus;
  progress: number;
  duration: number | null;
  trimStart: number | null;
  trimEnd: number | null;
  trimOpen: boolean;
  previewUrl?: string;
  startedAt?: number;
  resultUrl?: string;
  resultBlob?: Blob;
  resultSize?: number;
  resultName?: string;
  error?: string;
};

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const VIDEO_EXTENSIONS = [
  ".mp4",
  ".mov",
  ".m4v",
  ".webm",
  ".mkv",
  ".avi",
  ".3gp",
  ".3g2",
  ".wmv",
  ".flv",
  ".ogv",
  ".mpg",
  ".mpeg",
  ".ts",
];

// Extensions/MIME prefixes we can be confident are NOT a video, used to
// reject obviously-wrong picks (a photo, a PDF, etc.) without needing a
// positive video match.
const NON_VIDEO_MIME_PREFIXES = ["image/", "audio/", "text/", "font/"];
const NON_VIDEO_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".heic",
  ".heif",
  ".webp",
  ".pdf",
  ".doc",
  ".docx",
  ".txt",
  ".zip",
  ".mp3",
  ".m4a",
  ".wav",
];

// Mobile pickers are unreliable about file.type for videos: iOS Safari's
// Photos-library picker (as opposed to the Files app) very commonly reports
// an empty type, or a generic "application/octet-stream", for large or
// HEVC-encoded videos — the browser hasn't sniffed the container yet. If we
// only trust an exact "video/*" match, real videos get silently dropped
// with no feedback, which is worse than occasionally letting a non-video
// through (ffmpeg will fail it with a visible, retryable error instead).
// So: reject only what we can positively identify as NOT a video; accept
// everything else.
function looksLikeVideo(file: File) {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();

  if (type.startsWith("video/")) return true;
  if (NON_VIDEO_MIME_PREFIXES.some((p) => type.startsWith(p))) return false;
  if (NON_VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) return false;
  if (VIDEO_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;

  // Unknown/generic type (e.g. "", "application/octet-stream") with an
  // unrecognized or missing extension — most common for mobile
  // camera-roll picks. Let it through rather than silently dropping it.
  return type === "" || type === "application/octet-stream";
}

function getVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    // iOS Safari can be unreliable about firing loadedmetadata on a video
    // element that's never attached to the document, so mount it off-screen
    // instead of leaving it detached. A timeout guards against it never
    // firing at all — duration is a nice-to-have, not a blocker for upload.
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.style.position = "fixed";
    video.style.width = "1px";
    video.style.height = "1px";
    video.style.opacity = "0";
    video.style.pointerEvents = "none";
    document.body.appendChild(video);

    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(video.src);
      video.remove();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8000);

    video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null);
    video.onerror = () => finish(null);
    video.src = URL.createObjectURL(file);
  });
}

function computeTargetVideoBitrateKbps(durationSeconds: number, targetMB: number, audioKbps = 128) {
  const totalKbits = targetMB * 8192;
  const totalKbps = totalKbits / durationSeconds;
  return Math.max(150, Math.round(totalKbps - audioKbps));
}

function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-zinc-500">
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 8h18M8 3v18" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 18h8a4 4 0 0 0 .5-7.97 5.5 5.5 0 0 0-10.6-1.5A4.5 4.5 0 0 0 6.5 17"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 20v-7m0 0-2.5 2.5M12 13l2.5 2.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ScissorsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="6" r="3" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="18" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 7.5L20 18M20 6L8.5 16.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function VideoCompressor() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [loadingCore, setLoadingCore] = useState(false);
  const [coreReady, setCoreReady] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [quality, setQuality] = useState<QualityKey>("medium");
  const [resolution, setResolution] = useState<ResolutionKey>("original");
  const [sizeMode, setSizeMode] = useState<SizeMode>("quality");
  const [targetSizeMB, setTargetSizeMB] = useState(10);
  const [batchRunning, setBatchRunning] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [tick, setTick] = useState(0);

  // queueRef mirrors `queue` synchronously. React does not guarantee that a
  // functional setState updater runs synchronously at call time, so we derive
  // `next` from queueRef.current ourselves (not from React's `prev`) and hand
  // setQueue an already-computed value. This way code that reads-then-acts in
  // the same call stack — e.g. retryItem kicking off compressAll() — always
  // sees fresh state instead of racing React's scheduler.
  const queueRef = useRef<QueueItem[]>([]);
  const setQueueSynced = (updater: QueueItem[] | ((prev: QueueItem[]) => QueueItem[])) => {
    const next = typeof updater === "function" ? (updater as (p: QueueItem[]) => QueueItem[])(queueRef.current) : updater;
    queueRef.current = next;
    setQueue(next);
  };

  const progressHandlerRef = useRef<(p: number) => void>(() => {});
  const cancelRef = useRef(false);

  // Restore persisted settings on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.quality && saved.quality in QUALITY_PRESETS) setQuality(saved.quality);
      if (saved.resolution && saved.resolution in RESOLUTIONS) setResolution(saved.resolution);
      if (saved.sizeMode === "quality" || saved.sizeMode === "targetSize") setSizeMode(saved.sizeMode);
      if (typeof saved.targetSizeMB === "number" && saved.targetSizeMB > 0) setTargetSizeMB(saved.targetSizeMB);
    } catch {
      // ignore malformed/unavailable storage
    }
  }, []);

  // Persist settings whenever they change.
  useEffect(() => {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ quality, resolution, sizeMode, targetSizeMB })
      );
    } catch {
      // storage may be unavailable (private browsing, quota) — non-critical
    }
  }, [quality, resolution, sizeMode, targetSizeMB]);

  // Tick every second while something is compressing, to drive elapsed/remaining time display.
  useEffect(() => {
    if (!batchRunning) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [batchRunning]);

  const updateItem = (id: string, patch: Partial<QueueItem>) => {
    setQueueSynced((q) => q.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const ensureCoreLoaded = useCallback(async () => {
    if (ffmpegRef.current && coreReady) return ffmpegRef.current;
    setLoadingCore(true);
    setLoadError(null);
    try {
      const ffmpeg = new FFmpeg();
      ffmpeg.on("progress", ({ progress: p }) => {
        progressHandlerRef.current(Math.min(100, Math.max(0, Math.round(p * 100))));
      });
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
        classWorkerURL: new URL("/ffmpeg/worker.js", window.location.origin).href,
      });
      ffmpegRef.current = ffmpeg;
      setCoreReady(true);
      return ffmpeg;
    } catch (e) {
      setLoadError("Failed to load the compression engine. Check your connection and try again.");
      throw e;
    } finally {
      setLoadingCore(false);
    }
  }, [coreReady]);

  const addFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const all = Array.from(files);
    const accepted = all.filter(looksLikeVideo);
    const items: QueueItem[] = accepted.map((f) => ({
      id: makeId(),
      file: f,
      status: "queued",
      progress: 0,
      duration: null,
      trimStart: null,
      trimEnd: null,
      trimOpen: false,
    }));
    if (items.length === 0) {
      setLoadError(
        all.length === 1
          ? `"${all[0].name}" doesn't look like a supported video file.`
          : "None of the selected files look like supported video files."
      );
      return;
    }
    setLoadError(null);
    setQueueSynced((q) => [...q, ...items]);
    items.forEach((item) => {
      getVideoDuration(item.file).then((duration) => {
        if (duration != null) updateItem(item.id, { duration, trimEnd: duration });
      });
    });
  };

  const removeItem = (id: string) => {
    setQueueSynced((q) => {
      const item = q.find((it) => it.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item?.resultUrl) URL.revokeObjectURL(item.resultUrl);
      return q.filter((it) => it.id !== id);
    });
  };

  const clearQueue = () => {
    setQueueSynced((q) => {
      for (const it of q) {
        if (it.status === "compressing") continue;
        if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
        if (it.resultUrl) URL.revokeObjectURL(it.resultUrl);
      }
      return q.filter((it) => it.status === "compressing");
    });
  };

  const retryItem = (id: string) => {
    updateItem(id, { status: "queued", progress: 0, error: undefined });
    if (!batchRunning) {
      void compressAll();
    }
  };

  const setTrim = (id: string, patch: Partial<Pick<QueueItem, "trimStart" | "trimEnd" | "trimOpen">>) => {
    updateItem(id, patch);
  };

  const toggleTrimPanel = (item: QueueItem) => {
    if (!item.trimOpen && !item.previewUrl) {
      updateItem(item.id, { trimOpen: true, previewUrl: URL.createObjectURL(item.file) });
    } else {
      updateItem(item.id, { trimOpen: !item.trimOpen });
    }
  };

  const compressOne = async (item: QueueItem) => {
    updateItem(item.id, { status: "compressing", progress: 0, error: undefined, startedAt: Date.now() });
    try {
      const ffmpeg = await ensureCoreLoaded();
      progressHandlerRef.current = (p) => updateItem(item.id, { progress: p });

      const inputName = "input-" + item.id + (item.file.name.match(/\.[^.]+$/)?.[0] ?? ".mp4");
      const outputName = "output-" + item.id + ".mp4";

      await ffmpeg.writeFile(inputName, await fetchFile(item.file));

      const args: string[] = [];
      const hasTrim =
        item.trimStart != null &&
        item.trimEnd != null &&
        item.duration != null &&
        (item.trimStart > 0 || item.trimEnd < item.duration);

      if (hasTrim && item.trimStart != null) {
        args.push("-ss", String(item.trimStart));
      }
      args.push("-i", inputName);
      if (hasTrim && item.trimStart != null && item.trimEnd != null) {
        args.push("-t", String(Math.max(0.1, item.trimEnd - item.trimStart)));
      }

      const scale = RESOLUTIONS[resolution].scale;
      if (scale) {
        args.push("-vf", `scale=${scale}`);
      }

      args.push("-c:v", "libx264", "-preset", "veryfast");

      if (sizeMode === "targetSize" && item.duration) {
        const effectiveDuration =
          hasTrim && item.trimStart != null && item.trimEnd != null
            ? item.trimEnd - item.trimStart
            : item.duration;
        const videoKbps = computeTargetVideoBitrateKbps(effectiveDuration, targetSizeMB);
        args.push(
          "-b:v",
          `${videoKbps}k`,
          "-maxrate",
          `${Math.round(videoKbps * 1.5)}k`,
          "-bufsize",
          `${videoKbps * 2}k`
        );
      } else {
        args.push("-crf", String(QUALITY_PRESETS[quality].crf));
      }

      args.push("-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", outputName);

      await ffmpeg.exec(args);

      const data = await ffmpeg.readFile(outputName);
      const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);

      updateItem(item.id, {
        status: "done",
        progress: 100,
        resultUrl: url,
        resultBlob: blob,
        resultSize: blob.size,
        resultName: item.file.name.replace(/\.[^.]+$/, "") + "-compressed.mp4",
      });

      await ffmpeg.deleteFile(inputName);
      await ffmpeg.deleteFile(outputName);
    } catch (e) {
      if (cancelRef.current) {
        updateItem(item.id, { status: "queued", progress: 0 });
      } else {
        console.error(e);
        updateItem(item.id, {
          status: "error",
          error: "Compression failed for this file.",
        });
      }
    }
  };

  const notifyBatchDone = (count: number) => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission !== "granted" || count === 0) return;
    try {
      new Notification("Compression complete", {
        body: `${count} video${count > 1 ? "s" : ""} ready to download.`,
      });
    } catch {
      // Notification construction can fail in some environments — non-critical
    }
  };

  const compressAll = async () => {
    cancelRef.current = false;
    setBatchRunning(true);
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      try {
        await Notification.requestPermission();
      } catch {
        // ignore — notifications are a nice-to-have
      }
    }
    let processed = 0;
    try {
      let next = queueRef.current.find((it) => it.status === "queued");
      while (next && !cancelRef.current) {
        await compressOne(next);
        processed += 1;
        if (cancelRef.current) break;
        next = queueRef.current.find((it) => it.status === "queued");
      }
    } finally {
      setBatchRunning(false);
      if (!cancelRef.current) notifyBatchDone(processed);
      cancelRef.current = false;
    }
  };

  const cancelBatch = () => {
    cancelRef.current = true;
    if (ffmpegRef.current) {
      ffmpegRef.current.terminate();
      ffmpegRef.current = null;
      setCoreReady(false);
    }
  };

  const downloadAllZip = async () => {
    const doneItems = queue.filter((it) => it.status === "done" && it.resultBlob);
    if (doneItems.length === 0) return;
    const files: Record<string, Uint8Array> = {};
    for (const it of doneItems) {
      const buf = new Uint8Array(await it.resultBlob!.arrayBuffer());
      files[it.resultName ?? `${it.file.name}-compressed.mp4`] = buf;
    }
    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "compressed-videos.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  const queuedCount = queue.filter((it) => it.status === "queued").length;
  const doneCount = queue.filter((it) => it.status === "done").length;
  const hasQueued = queuedCount > 0;
  void tick; // referenced to satisfy exhaustive-deps intent; drives re-render for elapsed/remaining time

  return (
    <div className="w-full max-w-xl mx-auto bg-white dark:bg-zinc-900 rounded-3xl border border-zinc-100 dark:border-zinc-800 shadow-[0_2px_10px_-2px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_10px_-2px_rgba(0,0,0,0.3)] p-6 flex flex-col gap-5 animate-fade-in-up">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-medium tracking-tighter text-zinc-900 dark:text-zinc-50">
            Compress video files
          </h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1.5">
            Compress large videos entirely in your browser. Nothing is uploaded anywhere.
          </p>
        </div>
        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-zinc-300 shrink-0 mt-1 transition-transform duration-500 ease-out hover:rotate-45 hover:scale-125 hover:text-zinc-400"
        >
          <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" />
        </svg>
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 p-0.5 text-xs font-mono font-medium">
          <button
            onClick={() => setSizeMode("quality")}
            disabled={batchRunning}
            className={`flex-1 rounded-md py-1.5 transition-colors ${
              sizeMode === "quality"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            QUALITY MODE
          </button>
          <button
            onClick={() => setSizeMode("targetSize")}
            disabled={batchRunning}
            className={`flex-1 rounded-md py-1.5 transition-colors ${
              sizeMode === "targetSize"
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-500 dark:text-zinc-400"
            }`}
          >
            TARGET SIZE
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {sizeMode === "quality" ? (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
                QUALITY
              </label>
              <div className="relative">
                <select
                  className="w-full appearance-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-3 pr-9 py-2 text-sm transition-all duration-150 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/20 hover:border-zinc-300 dark:hover:border-zinc-600"
                  value={quality}
                  onChange={(e) => setQuality(e.target.value as QualityKey)}
                  disabled={batchRunning}
                >
                  {Object.entries(QUALITY_PRESETS).map(([key, val]) => (
                    <option key={key} value={key}>
                      {val.label}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400">
                  <ChevronIcon />
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
                TARGET SIZE (MB)
              </label>
              <input
                type="number"
                min={1}
                step={1}
                value={targetSizeMB}
                onChange={(e) => setTargetSizeMB(Math.max(1, Number(e.target.value) || 1))}
                disabled={batchRunning}
                className="w-full rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm transition-all duration-150 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/20 hover:border-zinc-300 dark:hover:border-zinc-600"
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono font-medium tracking-wide text-zinc-500 dark:text-zinc-400">
              RESOLUTION
            </label>
            <div className="relative">
              <select
                className="w-full appearance-none rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 pl-3 pr-9 py-2 text-sm transition-all duration-150 outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-900/10 dark:focus:ring-zinc-100/20 hover:border-zinc-300 dark:hover:border-zinc-600"
                value={resolution}
                onChange={(e) => setResolution(e.target.value as ResolutionKey)}
                disabled={batchRunning}
              >
                {Object.entries(RESOLUTIONS).map(([key, val]) => (
                  <option key={key} value={key}>
                    {val.label}
                  </option>
                ))}
              </select>
              <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-400">
                <ChevronIcon />
              </span>
            </div>
          </div>
        </div>
      </div>

      <label
        className={`flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed py-9 cursor-pointer transition-all duration-200 ${
          isDragOver
            ? "border-zinc-500 dark:border-zinc-400 bg-zinc-50 dark:bg-zinc-800/60 scale-[1.01]"
            : "border-zinc-300 dark:border-zinc-700 hover:border-zinc-400 dark:hover:border-zinc-500 hover:bg-zinc-50/60 dark:hover:bg-zinc-800/40"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        <input
          type="file"
          accept="video/*,.mp4,.mov,.m4v,.avi,.3gp,.webm,.mkv"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <div
          className={`relative flex items-center justify-center w-14 h-14 rounded-2xl bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 shadow-sm text-zinc-400 transition-transform duration-300 ${
            isDragOver ? "scale-110 -translate-y-0.5 text-zinc-600 dark:text-zinc-200" : ""
          }`}
        >
          <UploadIcon />
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-300 text-center px-6">
          <span className="font-medium underline underline-offset-2">Click to upload</span> or drag
          and drop
        </p>
        <p className="text-xs text-zinc-400 text-center px-6">
          Add as many videos as you like — they'll queue up
        </p>
      </label>

      {loadError && (
        <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/40 rounded-lg px-3 py-2">
          {loadError}
        </p>
      )}

      {queue.length > 0 && (
        <div className="flex flex-col gap-2 max-h-80 overflow-y-auto pr-1">
          {queue.map((item) => {
            const elapsedMs = item.startedAt ? Date.now() - item.startedAt : 0;
            const elapsedSec = elapsedMs / 1000;
            const estTotalSec = item.progress > 3 ? elapsedSec / (item.progress / 100) : null;
            const remainingSec = estTotalSec != null ? Math.max(0, estTotalSec - elapsedSec) : null;

            return (
              <div
                key={item.id}
                className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-3 flex flex-col gap-2 animate-fade-in-up transition-shadow duration-200 hover:shadow-sm"
              >
                <div className="flex items-start gap-3">
                  <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-zinc-100 dark:bg-zinc-800 shrink-0">
                    <FileIcon />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate">
                      {item.file.name}
                    </p>
                    <p className="text-xs font-mono text-zinc-400">
                      {formatBytes(item.file.size)}
                      {item.duration != null && ` · ${formatTime(item.duration)}`}
                    </p>
                  </div>
                  {item.status !== "compressing" && (
                    <button
                      onClick={() => removeItem(item.id)}
                      className="text-zinc-400 p-1 shrink-0 rounded-md"
                      aria-label={`Remove ${item.file.name}`}
                    >
                      <XIcon />
                    </button>
                  )}
                </div>

                {item.status === "queued" && item.duration != null && (
                  <div className="pl-12">
                    <button
                      onClick={() => toggleTrimPanel(item)}
                      className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400"
                    >
                      <ScissorsIcon />
                      {item.trimOpen ? "Hide trim" : "Trim clip"}
                      {item.trimStart != null &&
                        item.trimEnd != null &&
                        (item.trimStart > 0 || item.trimEnd < item.duration) && (
                          <span className="text-zinc-400">
                            ({formatTime(item.trimStart)}–{formatTime(item.trimEnd)})
                          </span>
                        )}
                    </button>
                    {item.trimOpen && item.previewUrl && (
                      <div className="flex flex-col gap-2 mt-2">
                        <video
                          src={item.previewUrl}
                          controls
                          className="w-full rounded-lg max-h-40"
                        />
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            Start
                            <input
                              type="number"
                              min={0}
                              max={item.trimEnd ?? item.duration}
                              step={0.1}
                              value={item.trimStart ?? 0}
                              onChange={(e) =>
                                setTrim(item.id, { trimStart: Math.max(0, Number(e.target.value) || 0) })
                              }
                              className="w-16 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs font-mono"
                            />
                          </label>
                          <label className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                            End
                            <input
                              type="number"
                              min={item.trimStart ?? 0}
                              max={item.duration}
                              step={0.1}
                              value={item.trimEnd ?? item.duration}
                              onChange={(e) =>
                                setTrim(item.id, {
                                  trimEnd: Math.min(item.duration ?? 0, Number(e.target.value) || 0),
                                })
                              }
                              className="w-16 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-xs font-mono"
                            />
                          </label>
                          <button
                            onClick={() =>
                              setTrim(item.id, { trimStart: 0, trimEnd: item.duration })
                            }
                            className="text-xs text-zinc-400 underline underline-offset-2"
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {item.status === "done" && item.resultUrl && item.resultSize != null ? (
                  <div className="flex items-center justify-between gap-3 pl-12">
                    <span className="flex items-center gap-1.5 text-xs font-mono text-green-600 dark:text-green-400">
                      <span className="animate-pop-in">
                        <CheckIcon />
                      </span>
                      {formatBytes(item.resultSize)}
                      {" · "}
                      {Math.round((1 - item.resultSize / item.file.size) * 100)}% smaller
                    </span>
                    <a
                      href={item.resultUrl}
                      download={item.resultName}
                      className="text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 shrink-0"
                    >
                      Download
                    </a>
                  </div>
                ) : item.status === "error" ? (
                  <div className="flex items-center justify-between gap-3 pl-12">
                    <p className="text-xs text-red-600 dark:text-red-400">{item.error}</p>
                    <button
                      onClick={() => retryItem(item.id)}
                      className="text-xs font-medium rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 shrink-0"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 pl-12">
                    <div className="flex-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                      <div
                        className={`relative h-full transition-all duration-200 overflow-hidden ${
                          item.status === "compressing" ? "bg-zinc-900 dark:bg-zinc-100" : "bg-zinc-300 dark:bg-zinc-700"
                        }`}
                        style={{ width: `${item.progress}%` }}
                      >
                        {item.status === "compressing" && (
                          <div className="absolute inset-0 animate-shimmer" />
                        )}
                      </div>
                    </div>
                    <span className="text-xs font-mono text-zinc-400 whitespace-nowrap">
                      {item.status === "queued"
                        ? "Waiting"
                        : remainingSec != null
                          ? `${item.progress}% · ${formatTime(remainingSec)} left`
                          : `${item.progress}%`}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {doneCount > 1 && (
        <button
          onClick={downloadAllZip}
          className="self-start text-xs font-medium text-zinc-500 dark:text-zinc-400 underline underline-offset-2"
        >
          Download all {doneCount} as .zip
        </button>
      )}

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-zinc-100 dark:border-zinc-800 mt-1">
        {batchRunning ? (
          <>
            <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Compressing…</span>
            <button
              onClick={cancelBatch}
              className="rounded-xl border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 px-5 py-3 text-sm font-medium"
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <button
              onClick={clearQueue}
              disabled={queue.length === 0}
              className="rounded-xl border border-zinc-300 dark:border-zinc-700 px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Clear all
            </button>
            <button
              onClick={compressAll}
              disabled={!hasQueued || loadingCore}
              className="rounded-xl bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 px-5 py-3 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loadingCore
                ? "Loading engine…"
                : queuedCount > 0
                  ? `Compress ${queuedCount} file${queuedCount > 1 ? "s" : ""}`
                  : "Compress all"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
