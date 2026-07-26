import React from "react";

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);

    this.state = {
      hasError: false,
      errorMessage: "",
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message || "不明なエラーが発生しました",
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error("画面描画エラー:", error);
    console.error("エラー詳細:", errorInfo);
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
              maxWidth: "420px",
              padding: "28px 22px",
              borderRadius: "16px",
              background: "#ffffff",
              boxShadow: "0 8px 30px rgba(0, 0, 0, 0.12)",
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

            {this.state.errorMessage && (
              <details
                style={{
                  marginTop: "18px",
                  textAlign: "left",
                  fontSize: "12px",
                  color: "#6b7280",
                }}
              >
                <summary>エラー情報</summary>
                <div
                  style={{
                    marginTop: "8px",
                    overflowWrap: "anywhere",
                  }}
                >
                  {this.state.errorMessage}
                </div>
              </details>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
