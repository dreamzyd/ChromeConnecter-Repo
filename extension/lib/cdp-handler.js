export class CDPHandler {
  constructor(tabId) {
    this.tabId = tabId;
    this.target = { tabId };
    this.attached = false;
  }

  async attach() {
    try {
      if (this.attached) {
        return { success: true, data: true };
      }

      await chrome.debugger.attach(this.target, "1.3");
      await chrome.debugger.sendCommand(this.target, "Page.enable");
      await chrome.debugger.sendCommand(this.target, "Runtime.enable");
      await chrome.debugger.sendCommand(this.target, "DOM.enable");
      this.attached = true;
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async detach() {
    try {
      if (!this.attached) {
        return { success: true, data: true };
      }

      await chrome.debugger.detach(this.target);
      this.attached = false;
      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async sendCommand(method, params = {}) {
    const attached = await this.attach();
    if (!attached.success) {
      return attached;
    }

    try {
      const data = await chrome.debugger.sendCommand(this.target, method, params);
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async navigate(url) {
    try {
      return await this.sendCommand("Page.navigate", { url });
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async screenshot() {
    try {
      const result = await this.sendCommand("Page.captureScreenshot", { format: "png" });
      if (!result.success) {
        return result;
      }

      return { success: true, data: result.data?.data || "" };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async evaluate(expression) {
    try {
      const result = await this.sendCommand("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });

      if (!result.success) {
        return result;
      }

      if (result.data?.exceptionDetails) {
        return {
          success: false,
          error: result.data.exceptionDetails.text || "Expression evaluation failed"
        };
      }

      return { success: true, data: result.data?.result?.value };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async getPageContent() {
    try {
      return await this.evaluate(`(() => ({
        title: document.title,
        text: document.body ? document.body.innerText : "",
        url: document.URL
      }))()`);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async click(x, y) {
    try {
      const press = await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: 1
      });

      if (!press.success) {
        return press;
      }

      const release = await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: 1
      });

      if (!release.success) {
        return release;
      }

      return { success: true, data: { x, y } };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async type(text) {
    try {
      for (const character of String(text)) {
        const down = await this.sendCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: character,
          unmodifiedText: character,
          key: character
        });

        if (!down.success) {
          return down;
        }

        const charEvent = await this.sendCommand("Input.dispatchKeyEvent", {
          type: "char",
          text: character,
          unmodifiedText: character,
          key: character
        });

        if (!charEvent.success) {
          return charEvent;
        }

        const up = await this.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          text: character,
          unmodifiedText: character,
          key: character
        });

        if (!up.success) {
          return up;
        }
      }

      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async querySelector(selector) {
    try {
      const documentResult = await this.sendCommand("DOM.getDocument", { depth: -1, pierce: true });
      if (!documentResult.success) {
        return documentResult;
      }

      const nodeResult = await this.sendCommand("DOM.querySelector", {
        nodeId: documentResult.data.root.nodeId,
        selector
      });

      if (!nodeResult.success) {
        return nodeResult;
      }

      return { success: true, data: nodeResult.data?.nodeId || 0 };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async getElementBox(selector) {
    try {
      const nodeResult = await this.querySelector(selector);
      if (!nodeResult.success) {
        return nodeResult;
      }

      if (!nodeResult.data) {
        return { success: false, error: "Element not found" };
      }

      const boxResult = await this.sendCommand("DOM.getBoxModel", { nodeId: nodeResult.data });
      if (!boxResult.success) {
        return boxResult;
      }

      const content = boxResult.data?.model?.content;
      if (!Array.isArray(content) || content.length < 8) {
        return { success: false, error: "Unable to resolve element box" };
      }

      const xValues = [content[0], content[2], content[4], content[6]];
      const yValues = [content[1], content[3], content[5], content[7]];
      const minX = Math.min(...xValues);
      const maxX = Math.max(...xValues);
      const minY = Math.min(...yValues);
      const maxY = Math.max(...yValues);

      return {
        success: true,
        data: {
          x: minX + (maxX - minX) / 2,
          y: minY + (maxY - minY) / 2,
          width: maxX - minX,
          height: maxY - minY
        }
      };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async clickElement(selector) {
    try {
      const box = await this.getElementBox(selector);
      if (!box.success) {
        return box;
      }

      return await this.click(box.data.x, box.data.y);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async fillInput(selector, value) {
    try {
      const result = await this.evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) {
          return { ok: false, error: "Element not found" };
        }

        element.focus();
        element.value = ${JSON.stringify(String(value))};
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true };
      })()`);

      if (!result.success) {
        return result;
      }

      if (!result.data?.ok) {
        return { success: false, error: result.data?.error || "Failed to fill input" };
      }

      return { success: true, data: true };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async getPageHTML() {
    try {
      return await this.evaluate("document.documentElement.outerHTML");
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async getLinks() {
    try {
      return await this.evaluate(`Array.from(document.querySelectorAll("a[href]")).map((link) => ({
        text: (link.textContent || "").trim(),
        href: link.href
      }))`);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async getFormFields() {
    try {
      return await this.evaluate(`Array.from(document.querySelectorAll("input, select, textarea")).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.type || element.tagName.toLowerCase(),
        name: element.name || "",
        id: element.id || "",
        value: element.value || "",
        placeholder: element.placeholder || ""
      }))`);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async scrollTo(x, y) {
    try {
      return await this.evaluate(`window.scrollTo(${Number(x) || 0}, ${Number(y) || 0}); true;`);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }

  async scrollBy(dx, dy) {
    try {
      return await this.evaluate(`window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); true;`);
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }
}
