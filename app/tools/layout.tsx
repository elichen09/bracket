import LightOnly from "@/components/tools/LightOnly";

/** Everything under /tools is read close up, so it is read on paper. */
export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return <><LightOnly />{children}</>;
}
