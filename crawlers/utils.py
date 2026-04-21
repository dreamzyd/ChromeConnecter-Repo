import requests
import json
import os
import base64
from datetime import datetime

# --- 环境变量配置 ---
SESSION_TOKEN = os.environ.get("CHROME_SESSION_TOKEN", "")
RELAY_SERVER_URL = "http://127.0.0.1:18794"
BASE_DOWNLOAD_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "downloads"))

def send_command(action, params=None):
    if not SESSION_TOKEN:
        raise ValueError("缺少 CHROME_SESSION_TOKEN 环境变量。请先使用 export 设置它。")
        
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {SESSION_TOKEN}"
    }
    payload = {"action": action}
    if params:
        payload["params"] = params
        
    response = requests.post(f"{RELAY_SERVER_URL}/api/command", json=payload, headers=headers)
    result = response.json()
    if not result.get("success"):
        raise Exception(f"命令执行失败: {result.get('error')}")
    return result.get("data")

def get_save_dir(site_category, page_title):
    """
    根据网站分类和网页标题，生成结构化的保存目录
    """
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_title = "".join('_' if c == ' ' else c for c in page_title if c not in r'\/:*?"<>|').strip()
    while '__' in safe_title:
        safe_title = safe_title.replace('__', '_')
    safe_title = safe_title[:80]
    if not safe_title:
        safe_title = "unnamed_page"
        
    # 防止传入的 page_title 本身已经带了时间戳
    if "_" in safe_title and safe_title.split('_')[-1].isdigit() and len(safe_title.split('_')[-1]) == 6:
        # 如果看起来已经有时间戳了，就不再重复添加
        dir_path = os.path.join(BASE_DOWNLOAD_DIR, site_category, safe_title)
    else:
        dir_path = os.path.join(BASE_DOWNLOAD_DIR, site_category, f"{safe_title}_{timestamp}")
        
    os.makedirs(dir_path, exist_ok=True)
    return dir_path

def save_attachment(save_dir, filename, base64_data):
    """
    解码并保存 Base64 格式的附件
    """
    filename = "".join(c for c in filename if c not in r'\/:*?"<>|').strip() or "unnamed_file"
    if "," in base64_data:
        base64_data = base64_data.split(",")[1]
        
    file_data = base64.b64decode(base64_data)
    att_file_path = os.path.join(save_dir, filename)
    
    with open(att_file_path, "wb") as f:
        f.write(file_data)
    print(f"  -> ✅ 附件已保存: {att_file_path}")
    return att_file_path

def save_post_content(save_dir, title, text, url, attachment_count, attachment_names=None, is_local_download=False):
    """
    保存正文文本，并在文件最顶部注入醒目的抓取报告和元数据，
    包括来源 URL、附件数量、以及附件是否被强制下载到了本地电脑。
    """
    header = f"{'='*60}\n"
    header += f"🤖 网页抓取报告 (ChromeConnecter)\n"
    header += f"{'='*60}\n"
    header += f"📄 标题: {title}\n"
    header += f"🔗 来源网址: {url}\n"
    header += f"📎 探测到附件数量: {attachment_count} 个\n"
    
    if attachment_names and len(attachment_names) > 0:
        header += f"📁 附件列表: {', '.join(attachment_names)}\n"
        
    if attachment_count > 0:
        if is_local_download:
            header += f"⚠️ 附件状态: 受防爬机制(如动态Token)限制，附件未能保存到云服务器！\n"
            header += f"             已通过原生点击触发下载，请检查您【本地电脑】的 Downloads 文件夹！\n"
        else:
            header += f"✅ 附件状态: 附件已成功提取并保存至当前目录。\n"
            
    header += f"{'='*60}\n\n"
    
    file_path = os.path.join(save_dir, "post_content.txt")
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(header + text)
        
    print(f"  -> ✅ 网页文本及元数据报告已保存: {file_path}")
    return file_path
