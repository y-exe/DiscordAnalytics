"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps, ReactNode } from "react";

type NextThemesProps = ComponentProps<typeof NextThemesProvider>;

export default function ThemeProvider({
  children,
  nonce,
  ...props
}: Pick<NextThemesProps, "attribute" | "defaultTheme" | "enableSystem" | "nonce"> & {
  children: ReactNode;
}) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      nonce={nonce}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
