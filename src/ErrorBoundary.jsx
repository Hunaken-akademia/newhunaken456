import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      hasError: false,
      errorMessage: "",
      errorStack: "",
      componentStack: "",
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || "不明なエラーが発生しました",
      errorStack: error?.stack || "",
    };
  }

  componentDidCatch(error, errorInfo) {
    const errorStack = error?.stack || "";
    const componentStack = errorInfo?.componentStack || "";

    console.error("画面描画エラー:", error);
    console.error("エラー発生箇所:", errorStack);
    console.error("Reactコンポーネント:", componentStack);

    this.setState({
      errorStack,
      componentStack,
    });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px",
            background: "#f5f7fa",
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "520px",
              padding: "28px 22px",
              borderRadius: "16px",
              background: "#ffffff",
              boxShadow: "0 8px 30px rgba(0,0,0,.12)",
              textAlign: "center",
            }}
          >
            <h2
              style={{
                margin: "0 0 12px",
                fontSize: "20px",
                color: "#1f2937",
              }}
            >
              一時的な読み込みエラーが発生しました
            </h2>

            <p
              style={{
                margin: "0 0 20px",
                fontSize: "14px",
                lineHeight: "1.7",
                color: "#4b5563",
              }}
            >
              データ更新のタイミングにより、画面を正常に表示できませんでした。
              <br />
              下のボタンから再読み込みしてください。
            </p>

            <button
              type="button"
              onClick={this.handleReload}
              style={{
                width: "100%",
                padding: "13px 16px",
                border: "none",
                borderRadius: "10px",
                background: "#16a34a",
                color: "#ffffff",
                fontSize: "16px",
                fontWeight: "bold",
                cursor: "pointer",
              }}
            >
              再読み込みする
            </button>

            <details
              open
              style={{
                marginTop: "18px",
                textAlign: "left",
                fontSize: "12px",
                color: "#4b5563",
              }}
            >
              <summary style={{ fontWeight: "bold" }}>エラー情報</summary>

              <div
                style={{
                  marginTop: "10px",
                  padding: "10px",
                  borderRadius: "8px",
                  background: "#f3f4f6",
                  overflowWrap: "anywhere",
                  whiteSpace: "pre-wrap",
                }}
              >
                {this.state.errorMessage}
              </div>

              {this.state.errorStack && (
                <>
                  <div style={{ marginTop: "14px", fontWeight: "bold" }}>
                    発生箇所
                  </div>

                  <pre
                    style={{
                      marginTop: "6px",
                      padding: "10px",
                      borderRadius: "8px",
                      background: "#111827",
                      color: "#e5e7eb",
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      fontSize: "11px",
                      lineHeight: "1.5",
                    }}
                  >
                    {this.state.errorStack}
                  </pre>
                </>
              )}

              {this.state.componentStack && (
                <>
                  <div style={{ marginTop: "14px", fontWeight: "bold" }}>
                    Reactコンポーネント
                  </div>

                  <pre
                    style={{
                      marginTop: "6px",
                      padding: "10px",
                      borderRadius: "8px",
                      background: "#f3f4f6",
                      overflowX: "auto",
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      fontSize: "11px",
                      lineHeight: "1.5",
                    }}
                  >
                    {this.state.componentStack}
                  </pre>
                </>
              )}
            </details>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
