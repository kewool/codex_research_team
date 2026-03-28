type AnyObject = Record<string, any>;

export function createConfigControlTools(deps: {
  escapeHtml: (value: unknown) => string;
  availableSubgoalStages: () => string[];
}) {
  const { escapeHtml, availableSubgoalStages } = deps;

  function parseChannelListInput(value: string): string[] {
    return [...new Set(
      String(value || "")
        .split(/[\n,]+/g)
        .map((item) => item.trim())
        .filter(Boolean),
    )];
  }

  function configuredChannelList(config: AnyObject): string[] {
    const teamChannels = parseChannelListInput((config?.defaults?.extraChannels || []).join(","));
    const values = [
      String(config?.defaults?.goalChannel || "").trim(),
      String(config?.defaults?.operatorChannel || "").trim(),
      ...teamChannels,
      ...((config?.agents || []).flatMap((agent: AnyObject) => [
        String(agent?.publishChannel || "").trim(),
        ...((agent?.listenChannels || []).map((value: unknown) => String(value ?? "").trim())),
      ])),
    ];
    return [...new Set(values.filter(Boolean))];
  }

  function defaultPublishChannelForAgent(config: AnyObject): string {
    const channels = configuredChannelList(config).filter((channel) => channel !== String(config?.defaults?.goalChannel || "goal") && channel !== String(config?.defaults?.operatorChannel || "operator"));
    return channels[0] || String(config?.defaults?.goalChannel || "goal");
  }

  function defaultListenChannelsForAgent(config: AnyObject): string[] {
    const goal = String(config?.defaults?.goalChannel || "goal");
    const operator = String(config?.defaults?.operatorChannel || "operator");
    return [...new Set([goal, operator])];
  }

  function remapSemanticChannel(channel: string, previousDefaults: AnyObject, nextDefaults: AnyObject): string {
    const value = String(channel || "").trim();
    if (!value) {
      return "";
    }
    const pairs: Array<[string, string]> = [
      [String(previousDefaults?.goalChannel || "goal"), String(nextDefaults?.goalChannel || "goal")],
      [String(previousDefaults?.operatorChannel || "operator"), String(nextDefaults?.operatorChannel || "operator")],
    ];
    for (const [before, after] of pairs) {
      if (value === before && after) {
        return after;
      }
    }
    return value;
  }

  function renderChannelSelect(attributes: string, channels: string[], selected: string, emptyLabel = "Select channel"): string {
    const deduped = [...new Set([...channels, selected].map((value) => String(value || "").trim()).filter(Boolean))];
    const options = [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...deduped.map((channel) => `<option value="${escapeHtml(channel)}" ${selected === channel ? "selected" : ""}>${escapeHtml(channel)}</option>`),
    ];
    return `<select ${attributes}>${options.join("")}</select>`;
  }

  function renderChannelCheckboxPicker(attributeName: string, index: number, channels: string[], selectedValues: string[]): string {
    const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
    const options = [...new Set([...channels, ...selected])];
    return `
      <div class="channel-picker">
        ${options.map((channel) => `
          <label class="channel-chip">
            <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(channel)}" ${selected.includes(channel) ? "checked" : ""} />
            <span>${escapeHtml(channel)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  function renderAgentCheckboxPicker(attributeName: string, index: number, options: string[], selectedValues: string[]): string {
    const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
    const values = [...new Set([...options, ...selected])];
    return `
      <div class="channel-picker">
        ${values.map((value) => `
          <label class="channel-chip">
            <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} />
            <span>${escapeHtml(value)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  function renderOptionCheckboxPicker(attributeName: string, options: string[], selectedValues: string[]): string {
    const selected = [...new Set(selectedValues.map((value) => String(value || "").trim()).filter(Boolean))];
    const values = [...new Set([...options, ...selected])];
    return `
      <div class="channel-picker">
        ${values.map((value) => `
          <label class="channel-chip">
            <input type="checkbox" ${attributeName} value="${escapeHtml(value)}" ${selected.includes(value) ? "checked" : ""} />
            <span>${escapeHtml(value)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  function renderStageCheckboxPicker(attributeName: string, index: number, selectedValues: string[]): string {
    return `
      <div class="channel-picker">
        ${availableSubgoalStages().map((stage) => `
          <label class="channel-chip">
            <input type="checkbox" ${attributeName}="${index}" value="${escapeHtml(stage)}" ${selectedValues.includes(stage) ? "checked" : ""} />
            <span>${escapeHtml(stage)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  function parseLineListInput(value: string): string[] {
    return [...new Set(
      String(value || "")
        .split(/\r?\n/g)
        .map((item) => item.trim())
        .filter(Boolean),
    )];
  }

  function renderModelSelect(attributes: string, options: string[], selected: string | null, emptyLabel: string): string {
    const normalized = String(selected || "").trim();
    const deduped = [...new Set(options.filter(Boolean))];
    const selectOptions = [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...deduped.map((model) => `<option value="${escapeHtml(model)}" ${normalized === model ? "selected" : ""}>${escapeHtml(model)}</option>`),
    ];
    return `<select ${attributes}>${selectOptions.join("")}</select>`;
  }

  function renderReasoningEffortSelect(attributes: string, options: string[], selected: string | null, emptyLabel: string): string {
    const normalized = String(selected || "").trim();
    const deduped = [...new Set(options.filter(Boolean))];
    const selectOptions = [
      `<option value="">${escapeHtml(emptyLabel)}</option>`,
      ...deduped.map((value) => `<option value="${escapeHtml(value)}" ${normalized === value ? "selected" : ""}>${escapeHtml(value)}</option>`),
    ];
    return `<select ${attributes}>${selectOptions.join("")}</select>`;
  }

  return {
    configuredChannelList,
    defaultListenChannelsForAgent,
    defaultPublishChannelForAgent,
    parseChannelListInput,
    parseLineListInput,
    remapSemanticChannel,
    renderAgentCheckboxPicker,
    renderChannelCheckboxPicker,
    renderChannelSelect,
    renderModelSelect,
    renderOptionCheckboxPicker,
    renderReasoningEffortSelect,
    renderStageCheckboxPicker,
  };
}
