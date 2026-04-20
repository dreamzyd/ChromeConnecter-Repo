import sys
import time
import os

# 导入共用工具库
from utils import send_command, get_save_dir, save_attachment

# ==========================================
# 站点分类标识（用于创建文件夹结构，请保持唯一）
# ==========================================
SITE_CATEGORY = "quantclass_bbs"

def crawl(target_url):
    print(f"\n[1] 正在导航到目标网址: {target_url}")
    send_command("navigate", {"url": target_url})
    
    # 论坛可能加载较慢，给予充分等待时间
    time.sleep(5)  

    print("[2] 尝试机械化获取网页正文...")
    content_data = send_command("getContent")
    post_title = content_data.get("title", "未命名网页")
    post_text = content_data.get("text", "")
    
    # 动态获取保存目录： downloads/quantclass_bbs/2026-04-20_标题/
    save_dir = get_save_dir(SITE_CATEGORY, post_title)
    
    text_file_path = os.path.join(save_dir, "post_content.txt")
    with open(text_file_path, "w", encoding="utf-8") as f:
        f.write(post_text)
    print(f"  -> ✅ 网页文本已保存: {text_file_path} (共 {len(post_text)} 字)")

    print("[3] 尝试机械化探测并下载附件 (针对该论坛定制)...")
    # TODO: AI 助理需要根据实际 DOM 结构在此修改选择器
    # 示例: 查找所有 a 标签中带 download 属性的，或者 href 包含 zip/rar 的
    download_js = """
    (async () => {
        const extRegex = /\.(zip|rar|7z|pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt)$/i;
        const links = Array.from(document.querySelectorAll('a'));
        const targetLinks = links.filter(a => a.hasAttribute('download') || extRegex.test(a.href) || a.className.includes('attachment'));
        
        const results = [];
        for (let link of targetLinks) {
            try {
                const response = await fetch(link.href);
                const blob = await response.blob();
                const base64data = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                results.push({
                    filename: link.innerText.trim() || link.href.split('/').pop() || 'unknown_file',
                    data: base64data
                });
            } catch (e) {
                console.error('下载失败:', e);
            }
        }
        return results;
    })();
    """
    
    attachments = send_command("evaluate", {"expression": download_js})
    
    if not attachments:
        print("  -> ⚠️ 未探测到任何附件。")
    else:
        for att in attachments:
            save_attachment(save_dir, att["filename"], att["data"])
            
    print(f"\n🎉 抓取任务结束！所有文件已统一存放至: {save_dir}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("使用方法: python3 crawler_template.py <目标网址>")
        sys.exit(1)
        
    url = sys.argv[1]
    crawl(url)