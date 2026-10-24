#ifndef CROSSGRAM_TGCALLS_SHIM_H_
#define CROSSGRAM_TGCALLS_SHIM_H_

#include <stdint.h>

#if defined(_WIN32)
#define CROSSGRAM_TGCALLS_SHIM_API __declspec(dllexport)
#elif defined(__GNUC__)
#define CROSSGRAM_TGCALLS_SHIM_API __attribute__((visibility("default")))
#else
#define CROSSGRAM_TGCALLS_SHIM_API
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define CROSSGRAM_TGCALLS_SHIM_ABI_VERSION UINT32_C(4)
#define CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_RATE_HZ 48000u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CHANNELS 1u
#define CROSSGRAM_TGCALLS_SHIM_PCM_SAMPLE_BYTES 2u
#define CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_DURATION_MS 20u
#define CROSSGRAM_TGCALLS_SHIM_PCM_FRAME_SAMPLES 960u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_DURATION_MS 10u
#define CROSSGRAM_TGCALLS_SHIM_PCM_CALLBACK_SAMPLES 480u
#define CROSSGRAM_TGCALLS_SHIM_PCM_QUEUE_CAPACITY 4u
#define CROSSGRAM_TGCALLS_SHIM_AUTH_KEY_BYTES 256u
#define CROSSGRAM_TGCALLS_SHIM_MAX_ENDPOINTS 16u
#define CROSSGRAM_TGCALLS_SHIM_MAX_RTC_SERVERS 16u
#define CROSSGRAM_TGCALLS_SHIM_MAX_SIGNAL_BYTES 32768u

typedef struct crossgram_tgcalls_shim crossgram_tgcalls_shim;
typedef struct crossgram_tgcalls_pcm_bridge crossgram_tgcalls_pcm_bridge;

typedef uint32_t crossgram_tgcalls_shim_status;
typedef uint32_t crossgram_tgcalls_endpoint_type;
typedef uint32_t crossgram_tgcalls_protocol_version;

#define CROSSGRAM_TGCALLS_SHIM_STATUS_OK UINT32_C(0)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_ARGUMENT UINT32_C(1)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_STOPPED UINT32_C(2)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INPUT_FULL UINT32_C(3)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_OUTPUT_EMPTY UINT32_C(4)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_ABI_MISMATCH UINT32_C(5)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_ALLOCATION_FAILED UINT32_C(6)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INVALID_STATE UINT32_C(7)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_BACKEND_UNAVAILABLE UINT32_C(8)
#define CROSSGRAM_TGCALLS_SHIM_STATUS_INTERNAL_ERROR UINT32_C(9)

#define CROSSGRAM_TGCALLS_ENDPOINT_INET UINT32_C(0)
#define CROSSGRAM_TGCALLS_ENDPOINT_LAN UINT32_C(1)
#define CROSSGRAM_TGCALLS_ENDPOINT_UDP_RELAY UINT32_C(2)
#define CROSSGRAM_TGCALLS_ENDPOINT_TCP_RELAY UINT32_C(3)

#define CROSSGRAM_TGCALLS_PROTOCOL_V0 UINT32_C(0)
#define CROSSGRAM_TGCALLS_PROTOCOL_V1 UINT32_C(1)

/** 非拥有型 UTF-8 视图（由会话创建过程同步拷贝，不得包含内嵌 NUL）。 */
typedef struct crossgram_tgcalls_string_view {
  const char* data;
  uint32_t length;
} crossgram_tgcalls_string_view;

/** 单个 Telegram 通话端点；`ipv4` 与 `ipv6` 不可同时为空。 */
typedef struct crossgram_tgcalls_endpoint {
  int64_t id;
  crossgram_tgcalls_string_view ipv4;
  crossgram_tgcalls_string_view ipv6;
  uint16_t port;
  crossgram_tgcalls_endpoint_type type;
  uint8_t peer_tag[16];
} crossgram_tgcalls_endpoint;

typedef struct crossgram_tgcalls_rtc_server {
  uint8_t id;
  crossgram_tgcalls_string_view host;
  uint16_t port;
  crossgram_tgcalls_string_view username;
  crossgram_tgcalls_string_view password;
  uint8_t is_turn;
  uint8_t is_tcp;
} crossgram_tgcalls_rtc_server;

/** 传输与音频处理参数；布尔字段仅允许 `0` 或 `1`，超时单位为毫秒（`0` 表示使用上游默认值）。 */
typedef struct crossgram_tgcalls_session_config {
  uint32_t initialization_timeout_ms;
  uint32_t receive_timeout_ms;
  uint8_t enable_p2p;
  uint8_t allow_tcp;
  uint8_t enable_aec;
  uint8_t enable_ns;
  uint8_t enable_agc;
  crossgram_tgcalls_protocol_version protocol_version;
} crossgram_tgcalls_session_config;

/** 256 字节 Telegram 通话鉴权密钥；会话在创建时同步拷贝并在销毁时擦除。 */
typedef struct crossgram_tgcalls_session_auth {
  const uint8_t* key;
  uint32_t key_length;
  uint8_t is_outgoing;
} crossgram_tgcalls_session_auth;

/** 上游网络线程产生出站信令时触发；`data` 仅在本次调用内有效，回调内不得重入任何会话 API。 */
typedef void (*crossgram_tgcalls_outbound_signaling_callback)(
    void* context, const uint8_t* data, uint32_t length);

/** 同步上报致命或 API 错误码；回调不得抛出异常或重入会话。 */
typedef void (*crossgram_tgcalls_error_callback)(
    void* context, crossgram_tgcalls_shim_status status);

typedef struct crossgram_tgcalls_session_callbacks {
  void* context;
  crossgram_tgcalls_outbound_signaling_callback outbound_signaling;
  crossgram_tgcalls_error_callback error;
} crossgram_tgcalls_session_callbacks;

CROSSGRAM_TGCALLS_SHIM_API uint32_t crossgram_tgcalls_shim_abi_version(void);

/**
 * 创建会话及其有界 PCM 桥，并在返回前同步拷贝所有入参。
 * `endpoint_count > 0` 时 `endpoints` 不可为空；仅当 `config->enable_p2p == 1` 时允许 `endpoints == NULL && endpoint_count == 0`。
 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_create(
    uint32_t abi_version,
    const crossgram_tgcalls_session_config* config,
    const crossgram_tgcalls_session_auth* auth,
    const crossgram_tgcalls_endpoint* endpoints,
    uint32_t endpoint_count,
    const crossgram_tgcalls_rtc_server* rtc_servers,
    uint32_t rtc_server_count,
    const crossgram_tgcalls_session_callbacks* callbacks,
    crossgram_tgcalls_shim** out_session);

CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_start(
    crossgram_tgcalls_shim* session);

CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_receive_signaling(
    crossgram_tgcalls_shim* session,
    const uint8_t* data,
    uint32_t length);

/** 推拉 20 ms 单声道 48 kHz `int16_t` PCM 帧（960 采样点 / 1920 字节）。 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_push_capture_20ms(
    crossgram_tgcalls_shim* session, const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_pop_playout_20ms(
    crossgram_tgcalls_shim* session, int16_t* samples);

/**
 * 终态控制调用按 `stop -> join -> destroy` 顺序幂等执行。
 * `join` 返回后保证不再进入新回调且已进入的回调均已返回；`destroy` 成功后将 `*session` 置空。
 */
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_stop(
    crossgram_tgcalls_shim* session);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_join(
    crossgram_tgcalls_shim* session);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_session_destroy(
    crossgram_tgcalls_shim** session);

CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_create(
    uint32_t abi_version,
    crossgram_tgcalls_pcm_bridge** out_bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_capture_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_capture_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_push_playout_10ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    const int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_pop_playout_20ms(
    crossgram_tgcalls_pcm_bridge* bridge,
    int16_t* samples);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_stop(
    crossgram_tgcalls_pcm_bridge* bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_drain(
    crossgram_tgcalls_pcm_bridge* bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_join(
    crossgram_tgcalls_pcm_bridge* bridge);
CROSSGRAM_TGCALLS_SHIM_API crossgram_tgcalls_shim_status crossgram_tgcalls_pcm_bridge_destroy(
    crossgram_tgcalls_pcm_bridge** bridge);
CROSSGRAM_TGCALLS_SHIM_API uint64_t crossgram_tgcalls_pcm_bridge_dropped_playout_frames(
    const crossgram_tgcalls_pcm_bridge* bridge);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // CROSSGRAM_TGCALLS_SHIM_H_
