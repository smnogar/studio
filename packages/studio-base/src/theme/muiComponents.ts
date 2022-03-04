// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Theme, ThemeOptions } from "@mui/material/styles";
import { CSSProperties } from "@mui/styles";

type MuiLabComponents = {
  MuiFocusVisible?: {
    styleOverrides?: {
      root?: CSSProperties;
    };
  };
  MuiToggleButton?: {
    styleOverrides?: {
      root?: CSSProperties;
      label?: CSSProperties;
    };
  };
  MuiToggleButtonGroup?: {
    styleOverrides?: {
      root?: CSSProperties;
    };
  };
};

const iconHack = {
  "& svg:not(.MuiSvgIcon-root)": {
    fill: "currentColor",
    width: "1em",
    height: "1em",
    display: "inline-block",
    fontSize: "1.2857142857142856rem",
    transition: "fill 200ms cubic-bezier(0.4, 0, 0.2, 1) 0ms",
    flexShrink: 0,
    userSelect: "none",
  },
};

export default function muiComponents(theme: Theme): ThemeOptions["components"] & MuiLabComponents {
  const prefersDarkMode = theme.palette.mode === "dark";

  return {
    MuiCssBaseline: {
      styleOverrides: {
        "@global": {
          svg: {
            display: "block",
            maxWidth: "100%",
          },
        },
      },
    },
    MuiAvatar: {
      defaultProps: {
        variant: "rounded",
      },
      styleOverrides: {
        colorDefault: {
          color: "currentColor",
          backgroundColor: theme.palette.action.hover,
        },
      },
    },
    MuiButton: {
      defaultProps: {
        disableElevation: true,
      },
    },
    MuiCard: {
      defaultProps: {
        variant: "outlined",
        square: false,
      },
    },
    MuiCardActionArea: {
      defaultProps: {
        disableRipple: true,
      },
    },
    MuiCardContent: {
      styleOverrides: {
        root: {
          "&:last-child": {
            paddingBottom: theme.spacing(2),
          },
        },
      },
    },
    MuiCardHeader: {
      defaultProps: {
        titleTypographyProps: {
          variant: "h3",
        },
      },
      styleOverrides: {
        action: {
          alignSelf: undefined,
          marginTop: undefined,
          marginRight: undefined,
        },
      },
    },
    MuiCheckbox: {
      defaultProps: {
        disableRipple: true,
      },
    },
    MuiFilledInput: {
      defaultProps: {
        disableUnderline: true,
      },
      styleOverrides: {
        input: {
          padding: theme.spacing(1, 1.25),
        },
        inputSizeSmall: {
          padding: theme.spacing(0.5, 1),
        },
        root: {
          borderRadius: theme.shape.borderRadius,

          "&.Mui-focused": {
            backgroundColor: theme.palette.action.focus,
          },
        },
      },
    },
    MuiFocusVisible: {
      styleOverrides: {
        root: {
          borderRadius: theme.shape.borderRadius,
        },
      },
    },
    MuiIconButton: {
      defaultProps: {
        centerRipple: false,
        disableRipple: true,
      },
      styleOverrides: {
        root: {
          borderRadius: theme.shape.borderRadius,
          ...iconHack,

          "&:hover": {
            backgroundColor: theme.palette.action.hover,
          },
        },
      },
    },
    MuiInput: {
      styleOverrides: {
        input: {
          padding: theme.spacing(1, 1.25),
        },
        inputSizeSmall: {
          padding: theme.spacing(0.5, 1),
        },
      },
    },
    MuiInputBase: {
      styleOverrides: {
        adornedEnd: {
          "&.MuiInputBase-sizeSmall": {
            paddingRight: theme.spacing(1),

            "& .MuiSvgIcon-root": {
              fontSize: "1rem",
            },
          },
        },
        adornedStart: {
          "&.MuiInputBase-sizeSmall": {
            paddingLeft: theme.spacing(1),

            "& .MuiSvgIcon-root": {
              fontSize: "1rem",
            },
            "& .MuiSelect-select": {
              paddingRight: `${theme.spacing(2)} !important`,
            },
          },
        },
        inputSizeSmall: {
          fontSize: theme.typography.body2.fontSize,
        },
        root: {
          "&.MuiInput-root": {
            marginTop: 0,
          },
        },
      },
    },
    MuiInputLabel: {
      defaultProps: {
        variant: "standard",
        sx: { position: "relative" },
      },
    },
    MuiLink: {
      defaultProps: {
        color: prefersDarkMode ? "secondary" : "primary",
      },
      styleOverrides: {
        root: {
          cursor: "pointer",
        },
      },
    },
    MuiListSubheader: {
      styleOverrides: {
        root: {
          lineHeight: theme.spacing(4),
        },
      },
    },
    MuiListItemButton: {
      defaultProps: { disableRipple: true },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          borderRadius: theme.shape.borderRadius,
        },
      },
    },
    MuiMenuItem: {
      defaultProps: {
        disableRipple: true,
      },
      styleOverrides: {
        dense: {
          minHeight: theme.spacing(3),
          paddingTop: 0,
          paddingBottom: 0,

          "& .MuiSvgIcon-root.MuiSvgIcon-fontSizeSmall": {
            fontSize: "1rem",
          },
        },
      },
    },
    MuiOutlinedInput: {
      styleOverrides: {
        input: {
          padding: theme.spacing(1, 1.25),
        },
        inputSizeSmall: {
          padding: theme.spacing(0.5, 1),
        },
      },
    },
    MuiPaper: {
      defaultProps: {
        elevation: 2,
        square: true,
      },
    },
    MuiRadio: {
      defaultProps: {
        disableRipple: true,
      },
    },
    MuiTab: {
      styleOverrides: {
        labelIcon: iconHack,
      },
    },
    MuiTableCell: {
      styleOverrides: {
        stickyHeader: {
          backgroundColor: theme.palette.background.paper,
        },
      },
    },
    MuiTextField: {
      defaultProps: {
        InputLabelProps: {
          shrink: true,
        },
        InputProps: {
          notched: false,
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        label: iconHack,
      },
    },
    MuiToolbar: {
      styleOverrides: {
        root: {
          justifyContent: "space-between",
        },
      },
    },
  };
}
