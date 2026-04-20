import requests
import json
import sys

RELAY_SERVER_URL = "http://127.0.0.1:18794"

def get_token(totp_code):
    try:
        response = requests.post(
            f"{RELAY_SERVER_URL}/api/connect",
            json={"totpCode": totp_code, "sessionDurationMs": 28800000} # 默认 8 小时
        )
        result = response.json()
        
        if result.get("success"):
            token = result.get("sessionToken")
            print("\n✅ 验证成功！请复制下方命令并在终端中执行：")
            print("-" * 60)
            print(f'export CHROME_SESSION_TOKEN="{token}"')
            print("-" * 60)
            print("执行后，即可使用 python3 crawlers/xxx.py 手动运行爬虫脚本。")
        else:
            print(f"\n❌ 验证失败: {result.get('error')}")
            print("提示：请确认你的 Chrome 浏览器插件处于【已连接】状态，且验证码输入正确。")
            
    except Exception as e:
        print(f"\n❌ 请求失败: {e}")
        print("请检查中继服务器 (Relay Server) 是否已启动。")

if __name__ == "__main__":
    print("=" * 60)
    print("🔐 ChromeConnecter 手动授权助手")
    print("=" * 60)
    code = input("📱 请输入 Authenticator 上的 6 位动态验证码: ").strip()
    
    if len(code) != 6 or not code.isdigit():
        print("❌ 错误：请输入 6 位数字验证码。")
        sys.exit(1)
        
    get_token(code)