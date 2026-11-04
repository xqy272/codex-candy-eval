<script setup lang="ts">
import { reactive } from 'vue'
import { workspace } from './workspace'
import { isPreview } from './api'
import { kinds, profiles, label } from './presentation'
import { artwork } from './media'
import TestResult from './components/TestResult.vue'
const w = reactive(workspace())
const kindName = (id: string) => kinds.find((k) => k.value === id)?.label ?? id
</script>
<template>
  <main class="eval-page">
    <header class="page-heading">
      <h1>模型测试</h1>
      <nav aria-label="插件导航">
        <button :aria-current="w.nav === 'test' ? 'page' : undefined" @click="w.nav = 'test'">
          测试</button
        ><button
          :aria-current="w.nav === 'history' ? 'page' : undefined"
          @click="w.nav = 'history'"
        >
          记录
        </button>
      </nav>
      <button class="quiet refresh" :disabled="w.loading || isPreview" @click="w.refresh">
        刷新
      </button>
    </header>
    <p v-if="isPreview" class="notice">从 CPR 插件入口打开后，可读取账号并发起检测。</p>
    <p v-if="w.error" role="alert" class="error">{{ w.error }}</p>
    <p v-if="w.notice" role="status" class="notice">{{ w.notice }}</p>
    <template v-if="w.nav === 'test'">
      <div class="type-tabs" role="tablist" aria-label="测试类型">
        <button
          v-for="k in kinds"
          :id="`tab-${k.value}`"
          :key="k.value"
          role="tab"
          aria-controls="test-workspace"
          :aria-selected="w.kind === k.value"
          @click="w.chooseKind(k.value)"
        >
          {{ k.label }}
        </button>
      </div>
      <div class="request-fields">
        <label
          >模型<select v-model="w.model" aria-label="模型" :disabled="w.busy || w.modelLoading">
            <option value="">
              {{
                w.modelLoading ? '正在读取模型' : w.models.length ? '请选择模型' : '暂无可用模型'
              }}
            </option>
            <option v-for="m in w.models" :key="m">{{ m }}</option>
          </select></label
        >
        <label
          >推理强度<select v-model="w.effort" aria-label="推理强度" :disabled="w.busy">
            <option value="">默认</option>
            <option
              v-for="s in ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']"
              :key="s"
            >
              {{ s }}
            </option>
          </select></label
        >
        <label
          >请求语境<select v-model="w.profile" aria-label="请求语境" :disabled="w.busy">
            <option v-for="(name, id) in profiles" :key="id" :value="id">{{ name }}</option>
          </select></label
        >
        <div v-if="w.keys.length === 1" class="field">
          <span>客户端 Key</span><span class="field-value">{{ w.keys[0]!.name }}</span>
        </div>
        <label v-else
          >客户端 Key<select v-model="w.keyId" aria-label="客户端 Key" :disabled="w.busy">
            <option value="">{{ w.keys.length ? '请选择 Key' : '暂无可用 Key' }}</option>
            <option v-for="k in w.keys" :key="k.id" :value="k.id">{{ k.name }}</option>
          </select></label
        >
        <label v-if="w.kind === 'candy'"
          >每账号次数<select v-model="w.repeats" aria-label="每账号次数" :disabled="w.busy">
            <option v-for="n in [1, 3, 5]" :key="n" :value="n">{{ n }} 次</option>
          </select></label
        >
        <label v-if="w.kind === 'pelican'"
          >绘图题目<select v-model="w.outputVersion" aria-label="绘图题目" :disabled="w.busy">
            <option value="svg-v1">标准 SVG v1</option>
            <option value="legacy-animation-v1">旧版 HTML 动画题</option>
          </select></label
        >
      </div>
      <div class="batch-toolbar">
        <span>{{ w.selected.length }} 个账号 · {{ w.planned }} 次计划请求</span
        ><label
          >并行账号<select
            v-model="w.concurrency"
            aria-label="并行账号数"
            :disabled="
              w.busy ||
              w.records.some((r) => r.task && ['queued', 'running', 'scoring'].includes(r.status))
            "
          >
            <option v-for="n in [1, 2, 3, 4]" :key="n" :value="n">{{ n }} 个</option>
          </select></label
        >
      </div>
      <p v-if="w.pending" class="warning">
        上次提交尚未确认。<button :disabled="w.busy" @click="w.sendPending">重试提交原批次</button>
      </p>
      <div class="mobile-target">
        <span>已选 {{ w.selected.length }} 个账号</span
        ><button class="quiet" @click="w.mobileAccounts = !w.mobileAccounts">
          {{ w.mobileAccounts ? '收起账号' : '选择账号' }}</button
        ><button class="primary" :disabled="!w.ready" @click="w.start">开始检测</button
        ><button v-if="w.running" class="quiet" :disabled="w.busy" @click="w.stopBatch">
          停止本批次
        </button>
      </div>
      <div id="test-workspace" class="workspace" role="tabpanel" :aria-labelledby="`tab-${w.kind}`">
        <aside class="accounts" :class="{ expanded: w.mobileAccounts }" aria-label="账号选择">
          <div class="aside-heading">
            <h2>账号</h2>
            <span class="muted">已选 {{ w.selected.length }} 个</span>
          </div>
          <input
            v-model="w.accountSearch"
            type="search"
            placeholder="搜索账号"
            aria-label="搜索账号"
          />
          <div class="selection-actions">
            <button class="quiet" @click="w.toggleFiltered(true)">选择筛选结果</button
            ><button class="quiet" @click="w.toggleFiltered(false)">取消选择</button>
          </div>
          <div
            v-for="a in w.pageAccounts"
            :key="a.account_id"
            class="account-row"
            :class="{ focused: w.focus === a.account_id, disabled: !a.enabled }"
          >
            <input
              v-model="w.selected"
              type="checkbox"
              :value="a.account_id"
              :disabled="!a.enabled || w.busy"
              :aria-label="`选择 ${a.name}`"
            /><button class="account-button" @click="w.focusAccount(a.account_id)">
              <strong>{{ a.name }}</strong
              ><small>{{ a.enabled ? w.accountStatus(a.account_id) : '已停用' }}</small>
            </button>
          </div>
          <p v-if="!w.accounts.length" class="empty muted">
            {{ w.loading ? '正在读取账号' : '暂无 OpenAI 账号' }}
          </p>
          <div v-if="w.filteredAccounts.length > 20" class="pagination">
            <button :disabled="w.accountPage === 0" @click="w.accountPage--">上一页</button
            ><span>{{ w.accountPage + 1 }}</span
            ><button
              :disabled="(w.accountPage + 1) * 20 >= w.filteredAccounts.length"
              @click="w.accountPage++"
            >
              下一页
            </button>
          </div>
          <div class="submit-area">
            <button class="primary" :disabled="!w.ready" @click="w.start">
              开始检测 · {{ w.selected.length }} 个账号
            </button>
            <p class="muted">{{ w.planned }} 次计划请求，宿主可能额外重试。</p>
            <p class="muted">消耗所选账号额度；同账号逐题执行。</p>
          </div>
        </aside>
        <section class="work-area" aria-label="当前测试结果">
          <div v-if="w.currentBatch" class="current-batch">
            <span
              >{{ w.batchStatus(w.currentBatch) }} · 完成 {{ w.completedAccounts.length }} /
              {{ w.batchAccounts.length }} 个账号<span v-if="w.waitingAccounts.length">
                · {{ w.waitingAccounts.length }} 个等待处理</span
              ></span
            ><button
              v-if="w.running || !w.currentBatch.ready"
              class="quiet"
              :disabled="w.busy"
              @click="w.stopBatch"
            >
              停止本批次
            </button>
          </div>
          <div v-if="w.batchAccounts.length > 1" class="account-results" aria-label="本批次账号">
            <button
              v-for="id in w.batchAccounts"
              :key="id"
              :aria-pressed="w.focus === id"
              @click="w.focusAccount(id)"
            >
              {{ w.accountLabel(id) }}<small>{{ w.accountStatus(id) }}</small>
            </button>
          </div>
          <div v-if="w.gallery.length" class="art-gallery" aria-label="本批次作品">
            <button
              v-for="r in w.gallery"
              :key="r.id"
              :aria-pressed="w.focus === r.accountId"
              @click="w.focusAccount(r.accountId)"
            >
              <img v-if="artwork(r).url" :src="artwork(r).url" alt="已生成作品缩略图" /><span v-else
                >作品已生成 · 查看代码</span
              ><strong>{{ r.accountName || w.accountLabel(r.accountId) }}</strong>
            </button>
          </div>
          <TestResult
            v-if="w.resultRecords.length"
            :key="w.resultRecords[0]!.id"
            :records="w.resultRecords"
            :clock="w.clock"
            :busy="w.busy"
            @action="w.action"
            @compare="w.compare"
          />
          <div v-else class="result-empty">
            <p class="eyebrow">{{ kindName(w.kind) }}</p>
            <h2>
              {{
                w.reportLoading
                  ? '正在读取已保存的结果'
                  : w.currentBatch
                    ? '选择账号查看结果'
                    : '选择账号，开始一次检测'
              }}
            </h2>
            <p>
              {{
                w.kind === 'fingerprint'
                  ? '三份有效数字样本后，展示参考库中的候选排名。'
                  : w.kind === 'candy'
                    ? '使用固定原题，标准答案为 21；执行失败独立记录。'
                    : '生成后直接预览 SVG，代码和作品一同保存。每次最多等待 10 分钟。'
              }}
            </p>
            <p class="muted">
              {{
                w.currentBatch
                  ? '原结果使用冻结的模型和请求条件。'
                  : '模型、强度、语境和 Key 只决定下一次检测。'
              }}
            </p>
          </div>
        </section>
      </div>
    </template>
    <template v-else>
      <div class="history-heading">
        <h2>检测记录</h2>
        <p class="muted">一次操作作为一个批次，失败和完成保留在一起。</p>
      </div>
      <div class="history-filters">
        <label
          >测试<select v-model="w.filterKind" aria-label="筛选测试">
            <option value="">全部测试</option>
            <option v-for="k in kinds" :key="k.value" :value="k.value">{{ k.label }}</option>
          </select></label
        ><label
          >账号<select v-model="w.filterAccount" aria-label="筛选账号">
            <option value="">全部账号</option>
            <option v-for="a in w.accounts" :key="a.account_id" :value="a.account_id">
              {{ a.name }}
            </option>
          </select></label
        ><label
          >状态<select v-model="w.filterStatus" aria-label="筛选状态">
            <option value="">全部状态</option>
            <option
              v-for="s in [
                '检测中',
                '部分完成',
                '全部完成',
                '已停止',
                '待确认提交',
                '部分记录已淘汰',
                '答对',
                '答错',
                '执行失败',
                '等待处理',
              ]"
              :key="s"
            >
              {{ s }}
            </option>
          </select></label
        ><label>日期<input v-model="w.filterDate" type="date" aria-label="筛选日期" /></label>
      </div>
      <article v-for="b in w.historyItems" :key="b.request.id" class="history-row">
        <div>
          <strong>{{ kindName(b.request.kind) }} · {{ b.request.accountIds.length }} 个账号</strong>
          <p class="muted">
            {{ b.request.model }} · {{ profiles[b.request.profile] }} ·
            {{ new Date(b.startedAt).toLocaleString() }}
          </p>
        </div>
        <span>{{ w.batchStatus(b) }}</span
        ><button @click="w.openBatch(b)">查看结果</button>
      </article>
      <article v-for="r in w.legacyItems" :key="r.id" class="history-row">
        <div>
          <strong
            >{{ kindName(r.kind) }} · {{ r.accountName || w.accountLabel(r.accountId) }}</strong
          >
          <p class="muted">
            {{ r.model }} · {{ new Date(r.startedAt).toLocaleString() }} ·
            {{ r.task ? '独立检测' : '旧版记录' }}
          </p>
        </div>
        <span>{{ label(r) }}</span
        ><button @click="w.openLegacy(r)">查看结果</button>
      </article>
      <p v-if="!w.historyItems.length && !w.legacyItems.length" class="empty muted">
        暂无符合筛选条件的记录
      </p>
      <div v-if="w.currentBatch" class="account-results">
        <button
          v-for="id in w.batchAccounts"
          :key="id"
          :aria-pressed="w.focus === id"
          @click="w.focusAccount(id)"
        >
          {{ w.accountLabel(id) }}
        </button>
      </div>
      <TestResult
        v-if="w.resultRecords.length && (w.historyId || w.legacyId)"
        :key="'history-' + w.resultRecords[0]!.id"
        :records="w.resultRecords"
        :clock="w.clock"
        :busy="w.busy"
        @action="w.action"
        @compare="w.compare"
      />
      <p class="muted retention">
        保留记录有容量上限；旧的已结束检测可能被淘汰。排队、执行和等待处理的检测受到保护。
      </p>
    </template>
    <section v-if="w.comparison.length" class="comparison">
      <div class="aside-heading">
        <h2>已有作品对比</h2>
        <button class="quiet" @click="w.comparison = []">关闭对比</button>
      </div>
      <p v-if="w.comparison.length === 1" class="muted">
        再打开一份已有作品并加入对比，无需重新生成。
      </p>
      <div class="comparison-grid">
        <figure v-for="r in w.comparison" :key="r.id">
          <img :src="artwork(r).url" alt="对比中的鹈鹕作品" />
          <figcaption>
            {{ r.accountName }} · {{ r.model }} · {{ r.effort || '默认强度' }} ·
            {{ profiles[r.requestProfile ?? 'simple-v1'] }} ·
            {{ new Date(r.startedAt).toLocaleString() }}
          </figcaption>
        </figure>
      </div>
    </section>
  </main>
</template>
