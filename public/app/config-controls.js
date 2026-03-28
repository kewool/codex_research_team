export function createConfigControlTools(deps) {
    const { escapeHtml, availableSubgoalStages } = deps;
    function parseChannelListInput(value) {
        return [...new Set(String(value || "")
                .split(/[\n,]+/g)
                .map((item) => item.trim())
                .filter(Boolean))];
    }
    function configuredChannelList(config) {
        const teamChannels = parseChannelListInput((config?.defaults?.extraChannels || []).join(","));
        const values = [
            String(config?.defaults?.goalChannel || "").trim(),
            String(config?.defaults?.operatorChannel || "").trim(),
            ...teamChannels,
            ...((config?.agents || []).flatMap((agent) => [
                String(agent?.publishChannel || "").trim(),
                ...((agent?.listenChannels || []).map((value) => String(value ?? "").trim())),
            ])),
        ];
        return [...new Set(values.filter(Boolean))];
    }
    function defaultPublishChannelForAgent(config) {
        const channels = configuredChannelList(config).filter((channel) => channel !== String(config?.defaults?.goalChannel || "goal") && channel !== String(config?.defaults?.operatorChannel || "operator"));
        return channels[0] || String(config?.defaults?.goalChannel || "goal");
    }
    function defaultListenChannelsForAgent(config) {
        const goal = String(config?.defaults?.goalChannel || "goal");
        const operator = String(config?.defaults?.operatorChannel || "operator");
        return [...new Set([goal, operator])];
    }
    function remapSemanticChannel(channel, previousDefaults, nextDefaults) {
        const value = String(channel || "").trim();
        if (!value) {
            return "";
        }
        const pairs = [
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
    function renderChannelSelect(attributes, channels, selected, emptyLabel = "Select channel") {
        const deduped = [...new Set([...channels, selected].map((value) => String(value || "").trim()).filter(Boolean))];
        const options = [
            `<option value="">${escapeHtml(emptyLabel)}</option>`,
            ...deduped.map((channel) => `<option value="${escapeHtml(channel)}" ${selected === channel ? "selected" : ""}>${escapeHtml(channel)}</option>`),
        ];
        return `<select ${attributes}>${options.join("")}</select>`;
    }
    function renderChannelCheckboxPicker(attributeName, index, channels, selectedValues) {
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
    function renderAgentCheckboxPicker(attributeName, index, options, selectedValues) {
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
    function renderOptionCheckboxPicker(attributeName, options, selectedValues) {
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
    function renderStageCheckboxPicker(attributeName, index, selectedValues) {
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
    function parseLineListInput(value) {
        return [...new Set(String(value || "")
                .split(/\r?\n/g)
                .map((item) => item.trim())
                .filter(Boolean))];
    }
    function renderModelSelect(attributes, options, selected, emptyLabel) {
        const normalized = String(selected || "").trim();
        const deduped = [...new Set(options.filter(Boolean))];
        const selectOptions = [
            `<option value="">${escapeHtml(emptyLabel)}</option>`,
            ...deduped.map((model) => `<option value="${escapeHtml(model)}" ${normalized === model ? "selected" : ""}>${escapeHtml(model)}</option>`),
        ];
        return `<select ${attributes}>${selectOptions.join("")}</select>`;
    }
    function renderReasoningEffortSelect(attributes, options, selected, emptyLabel) {
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
