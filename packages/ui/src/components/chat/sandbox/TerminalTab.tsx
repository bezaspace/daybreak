import { useEffect, useRef } from "react";

interface TerminalTabProps {
  html: string;
}

export function TerminalTab({ html }: TerminalTabProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [html]);

  return (
    <div
      ref={ref}
      className="h-full overflow-auto bg-black p-3 font-mono text-xs leading-relaxed text-green-400 scrollbar-thin"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html || '<span class="opacity-50">No terminal output yet.</span>' }}
    />
  );
}
