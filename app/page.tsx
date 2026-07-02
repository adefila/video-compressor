import VideoCompressor from "./components/VideoCompressor";

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center justify-center bg-zinc-50 dark:bg-black py-16 px-6">
      <VideoCompressor />
    </div>
  );
}
