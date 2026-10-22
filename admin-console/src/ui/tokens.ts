import type { ThemeConfig } from "antd";

/**
 * One visual language for the console.
 *
 * Values are shared with the approved prototype: the paper tone is a cool
 * neutral rather than a yellowed background, and text is darker than a typical
 * admin default because this console is read at small sizes all day.
 *
 * Ant Design is the implementation, not the acceptance criterion. These tokens
 * only describe what the prototype settled on.
 */
export const tokens = {
  canvas: "#f2f4ee",
  surface: "#ffffff",
  subtle: "#f7f8f4",
  ink: "#1c241f",
  ink2: "#38443b",
  muted: "#5c6a5f",
  faint: "#8a978d",
  line: "#dfe4d9",
  lineSoft: "#ebeee6",
  vermillion: "#c2451f",
  forest: "#375032",
  amber: "#96650f",
  danger: "#9c2f16"
} as const;

export const theme: ThemeConfig = {
  token: {
    colorPrimary: tokens.vermillion,
    colorInfo: tokens.forest,
    colorSuccess: tokens.forest,
    colorWarning: tokens.amber,
    colorError: tokens.danger,
    colorText: tokens.ink,
    colorTextSecondary: tokens.muted,
    colorTextTertiary: tokens.faint,
    colorBorder: tokens.line,
    colorBorderSecondary: tokens.lineSoft,
    colorBgLayout: tokens.canvas,
    colorBgContainer: tokens.surface,
    borderRadius: 6,
    borderRadiusLG: 8,
    fontSize: 14,
    fontFamily: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", system-ui, -apple-system, sans-serif',
    controlHeight: 32,
    wireframe: false
  },
  components: {
    Layout: {
      siderBg: tokens.surface,
      headerBg: tokens.surface,
      headerHeight: 56,
      bodyBg: tokens.canvas
    },
    Menu: {
      itemSelectedBg: "#eaeee3",
      itemSelectedColor: tokens.forest,
      itemHeight: 38,
      itemBorderRadius: 6,
      itemMarginInline: 6
    },
    Table: {
      headerBg: tokens.subtle,
      headerColor: tokens.ink2,
      headerSplitColor: tokens.lineSoft,
      rowHoverBg: "#f8faf4",
      cellPaddingBlock: 10
    },
    Card: {
      headerHeight: 46,
      paddingLG: 18
    },
    Button: {
      primaryShadow: "none",
      defaultShadow: "none",
      dangerShadow: "none",
      fontWeight: 500
    },
    Modal: {
      titleFontSize: 15
    },
    Alert: {
      // Ant Design derives these from the info/error tokens, which would make a
      // routine "not read" notice look like a black banner. The paper tones match
      // the rest of the console.
      colorInfoBg: "#f5f8f0",
      colorInfoBorder: "#dde5d3",
      colorWarningBg: "#fdf8ee",
      colorWarningBorder: "#e7d3ad",
      colorErrorBg: "#fdf3f0",
      colorErrorBorder: "#e9b6aa"
    },
    Segmented: {
      itemSelectedBg: tokens.surface
    }
  }
};
