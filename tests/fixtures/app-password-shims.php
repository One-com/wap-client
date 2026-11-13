<?php
/**
 * Shims shared by the standalone tests that reach the multisite and locking
 * parts of the Application Password code (AppPasswordGuard, AppPasswordLock,
 * AppPasswordManager::is_enforced_network_wide()).
 *
 * Every function is defined only when the including test has not defined its
 * own, so a test's shims always win. Scenario knobs, all optional:
 *   $GLOBALS['wap_test_multisite']        bool, default false
 *   $GLOBALS['wap_test_blog_id']          int, default 1
 *   $GLOBALS['wap_test_home_url']         this site's home URL, default https://example.test
 *   $GLOBALS['wap_test_plugin_dir']       WP_PLUGIN_DIR stand-in for plugin_basename()
 *   $GLOBALS['wap_test_network_ids']      int[] networks, default [1]
 *   $GLOBALS['wap_test_sitewide_plugins'] network ID => active_sitewide_plugins
 *
 * @package GroupOne\WapClient\Tests
 */

declare(strict_types=1);

if (!defined('ARRAY_A')) {
    define('ARRAY_A', 'ARRAY_A');
}

if (!function_exists('is_multisite')) {
    function is_multisite(): bool
    {
        return !empty($GLOBALS['wap_test_multisite']);
    }
}

if (!function_exists('get_current_blog_id')) {
    function get_current_blog_id(): int
    {
        return (int) ($GLOBALS['wap_test_blog_id'] ?? 1);
    }
}

if (!function_exists('home_url')) {
    function home_url(string $path = ''): string
    {
        return rtrim($GLOBALS['wap_test_home_url'] ?? 'https://example.test', '/') . '/' . ltrim($path, '/');
    }
}

if (!function_exists('trailingslashit')) {
    function trailingslashit(string $value): string
    {
        return rtrim($value, '/\\') . '/';
    }
}

if (!function_exists('wp_normalize_path')) {
    function wp_normalize_path(string $path): string
    {
        return str_replace('\\', '/', $path);
    }
}

if (!function_exists('plugin_basename')) {
    // Relative to the stand-in plugins folder, else the trimmed absolute path (as core does).
    function plugin_basename(string $file): string
    {
        $file = wp_normalize_path($file);
        $dir  = trailingslashit(wp_normalize_path($GLOBALS['wap_test_plugin_dir'] ?? '/srv/wp-content/plugins'));

        return trim(0 === strpos($file, $dir) ? substr($file, strlen($dir)) : $file, '/');
    }
}

if (!function_exists('get_networks')) {
    function get_networks(array $args = []): array
    {
        return $GLOBALS['wap_test_network_ids'] ?? [1];
    }
}

if (!function_exists('get_current_network_id')) {
    function get_current_network_id(): int
    {
        return 1;
    }
}

if (!function_exists('get_network_option')) {
    function get_network_option(int $network_id, string $option, $default = false)
    {
        if ('active_sitewide_plugins' === $option) {
            return $GLOBALS['wap_test_sitewide_plugins'][$network_id] ?? $default;
        }

        return $default;
    }
}

if (!function_exists('get_site_option')) {
    function get_site_option(string $option, $default = false)
    {
        return $GLOBALS['wap_test_site_options'][$option] ?? $default;
    }
}

if (!function_exists('update_site_option')) {
    function update_site_option(string $option, $value): bool
    {
        $GLOBALS['wap_test_site_options'][$option] = $value;
        return true;
    }
}

if (!function_exists('get_current_user_id')) {
    function get_current_user_id(): int
    {
        return (int) ($GLOBALS['wap_test_current_user'] ?? 0);
    }
}

if (!function_exists('wp_generate_password')) {
    function wp_generate_password(int $length = 12, bool $special_chars = true): string
    {
        return substr(bin2hex(random_bytes($length)), 0, $length);
    }
}

/**
 * In-memory $wpdb covering the SQL the Application Password code runs: the
 * lock row in the options table (INSERT IGNORE, SELECT, UPDATE, DELETE) and
 * the user meta LIKE scans. User meta is read from the named global, in the
 * test's own [user_id => [meta_key => value]] shape.
 */
class WapTestAppPasswordWpdb
{
    /** @var string */
    public $base_prefix = 'wp_';

    /** @var string */
    public $usermeta = 'wp_usermeta';

    /** @var string */
    public $last_error = '';

    /** @var array<string, string> Options-table rows: option_name => option_value. */
    public $options = [];

    /** @var array<int, string> Every query run, in order. */
    public $log = [];

    /** @var bool|int Make lock INSERTs fail like a database error: always (true), or the next N times. */
    public $fail_lock = false;

    /** @var bool */
    private $suppressed = false;

    /** @var bool Whether send_reads_to_masters() was called (HyperDB / LudicrousDB API). */
    public $reads_to_masters = false;

    /** @var string Global holding core's Application Passwords: [user_id => [item, ...]]. */
    private $passwords_global;

    /** @var callable|null Called when a lock INSERT finds the row taken: lets a test play the other request. */
    public $on_contention = null;

    /** @var string */
    private $meta_global;

    public function __construct(string $meta_global = 'wap_test_user_meta', string $passwords_global = 'wap_test_pws')
    {
        $this->meta_global      = $meta_global;
        $this->passwords_global = $passwords_global;
    }

    public function send_reads_to_masters(): void
    {
        $this->reads_to_masters = true;
    }

    public function suppress_errors(bool $suppress = true): bool
    {
        $previous         = $this->suppressed;
        $this->suppressed = $suppress;
        return $previous;
    }

    public function esc_like(string $text): string
    {
        return addcslashes($text, '_%\\');
    }

    public function prepare(string $query, ...$args): array
    {
        return ['sql' => $query, 'args' => $args];
    }

    /**
     * @return int|false Rows affected.
     */
    public function query(array $prepared)
    {
        $sql  = $prepared['sql'];
        $args = $prepared['args'];
        $this->log[] = $sql;

        if (0 === strpos($sql, 'INSERT IGNORE INTO `wp_options`')) {
            if (true === $this->fail_lock || (is_int($this->fail_lock) && $this->fail_lock-- > 0)) {
                $this->last_error = 'simulated database error';
                return false;
            }
            [$name, $value] = $args;
            if (isset($this->options[$name])) {
                if (null !== $this->on_contention) {
                    ($this->on_contention)($this);
                }
                return 0;
            }
            $this->options[$name] = $value;
            return 1;
        }

        if (0 === strpos($sql, 'UPDATE `wp_options`')) {
            [$value, $name, $old] = $args;
            if (($this->options[$name] ?? null) !== $old) {
                return 0;
            }
            $this->options[$name] = $value;
            return 1;
        }

        if (0 === strpos($sql, 'DELETE FROM `wp_options`')) {
            [$name, $value] = $args;
            if (($this->options[$name] ?? null) !== $value) {
                return 0;
            }
            unset($this->options[$name]);
            return 1;
        }

        $this->last_error = 'unsupported query: ' . $sql;
        return false;
    }

    public function get_var(array $prepared)
    {
        $this->log[] = $prepared['sql'];
        if (0 === strpos($prepared['sql'], 'SELECT `option_value` FROM `wp_options`')) {
            return $this->options[$prepared['args'][0]] ?? null;
        }

        return null;
    }

    /** Rows of "SELECT meta_key, meta_value … WHERE user_id = %d AND meta_key LIKE %s". */
    public function get_results(array $prepared, $output = null): array
    {
        $this->log[] = $prepared['sql'];
        $rows = [];
        foreach ($this->meta_like($prepared['args'][0], $prepared['args'][1]) as $key => $value) {
            $rows[] = ['meta_key' => $key, 'meta_value' => $value];
        }

        return $rows;
    }

    /**
     * Keys of "SELECT meta_key … WHERE user_id = %d AND meta_key LIKE %s", or the
     * users of "SELECT DISTINCT user_id … (meta_key = <passwords> AND (meta_value
     * LIKE <tag> OR meta_value LIKE <label>)) OR meta_key LIKE <uuid key prefix>".
     */
    public function get_col(array $prepared): array
    {
        $this->log[] = $prepared['sql'];

        if (0 === strpos($prepared['sql'], 'SELECT DISTINCT user_id')) {
            [, $like_tag, $like_label, $like_key] = $prepared['args'];
            $tag   = stripslashes(trim($like_tag, '%'));
            $label = stripslashes(trim($like_label, '%'));
            $users = [];
            foreach ($GLOBALS[$this->passwords_global] ?? [] as $user_id => $items) {
                foreach ($items as $item) {
                    if (false !== strpos((string) ($item['app_id'] ?? ''), $tag) || false !== strpos((string) ($item['name'] ?? ''), $label)) {
                        $users[$user_id] = (string) $user_id;
                    }
                }
            }
            foreach (array_keys($GLOBALS[$this->meta_global] ?? []) as $user_id) {
                if ([] !== $this->meta_like((int) $user_id, $like_key)) {
                    $users[$user_id] = (string) $user_id;
                }
            }
            return array_values($users);
        }

        return array_keys($this->meta_like($prepared['args'][0], $prepared['args'][1]));
    }

    private function meta_like(int $user_id, string $like): array
    {
        $prefix = stripslashes(rtrim($like, '%'));

        return array_filter(
            $GLOBALS[$this->meta_global][$user_id] ?? [],
            static function ($key) use ($prefix): bool {
                return 0 === strpos((string) $key, $prefix);
            },
            ARRAY_FILTER_USE_KEY
        );
    }
}

if (!function_exists('is_wp_error')) {
    function is_wp_error($thing): bool
    {
        return $thing instanceof WP_Error;
    }
}

if (!function_exists('wp_cache_delete')) {
    // Records what the library drops from the object cache: $GLOBALS['wap_test_cache_deletes'][] = [key, group].
    function wp_cache_delete($key, string $group = ''): bool
    {
        $GLOBALS['wap_test_cache_deletes'][] = [$key, $group];
        return true;
    }
}
