import sys
import time
import os

# 导入共用工具库
from utils import send_command, get_save_dir, save_attachment, save_post_content

# ==========================================
# 站点分类标识（用于创建文件夹结构，请保持唯一）
# ==========================================
SITE_CATEGORY = "example_site"

def crawl(target_url):
    print(f"\n[1] 正在导航到目标网址: {target_url}")
    send_command("navigate", {"url": target_url})
    
    # 给予充分等待时间
    time.sleep(5)  

    print("[2] 尝试机械化获取网页正文...")
    content_data = send_command("getContent")
    post_title = content_data.get("title", "未命名网页")
    post_text = content_data.get("text", "")
    
    # 动态获取保存目录
    save_dir = get_save_dir(SITE_CATEGORY, post_title)

    print("[3] 尝试机械化探测并下载附件...")
    # TODO: AI 助理需要根据实际 DOM 结构在此修改选择器
    # 如果遇到动态鉴权无法获取真实 URL，请直接使用 `element.click()` 原生点击，
    # 并将 is_local_download 设为 True
    download_js = """
    (async () => {
        const extRegex = /\.(zip|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt)$/i;
        const links = Array.from(document.querySelectorAll('a'));
        const targetLinks = links.filter(a => a.hasAttribute('download') || extRegex.test(a.href) || a.className.includes('attachment'));
        
        const results = {
            count: targetLinks.length,
            names: [],
            files: [],
            isLocalDownload: false
        };
        
        for (let link of targetLinks) {
            const filename = link.innerText.trim() || link.href.split('/').pop() || 'unknown_file';
            results.names.push(filename);
            
            try {
                // 尝试 fetch
                const response = await fetch(link.href);
                const blob = await response.blob();
                const base64data = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                results.files.push({
                    filename: filename,
                    data: base64data
                });
            } catch (e) {
                console.error('Fetch 失败，尝试物理点击:', e);
                // Fetch 失败说明有防爬机制，改用原生点击下载到用户本地电脑
                link.click();
                results.isLocalDownload = true;
            }
        }
        return results;
    })();
    """
    
    att_info = send_command("evaluate", {"expression": download_js})
    
    if att_info and att_info.get("files"):
        for att in att_info["files"]:
            save_attachment(save_dir, att["filename"], att["data"])
            
    # 无论附件下载到了哪里，都必须使用 save_post_content 生成带有醒目信息的头部
    attachment_count = att_info.get("count", 0) if att_info else 0
    attachment_names = att_info.get("names", []) if att_info else []
    is_local_download = att_info.get("isLocalDownload", False) if att_info else False
    
    save_post_content(save_dir, post_title, post_text, target_url, attachment_count, attachment_names, is_local_download)

    print(f"\n🎉 抓取任务结束！所有文件已统一存放至: {save_dir}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python3 crawler_template.py <目标网址>")
        sys.exit(1)
        
    url = sys.argv[1]
    crawl(url)