import LightOnly from "@/components/tools/LightOnly";
import ToolFx from "@/components/tools/ToolFx";
import { THEME_BOOT } from "@/lib/toolTheme";

/**
 * Everything under /tools is read close up, so it is read on paper — in the
 * colour scheme chosen in any tool's Colours button, set before first paint.
 */
export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      <LightOnly />
      <ToolFx />
      {children}
    </>
  );
}
