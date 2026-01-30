import { activateKeepAwake, deactivateKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { BluetoothHeartRateMonitor } from './components/BluetoothHeartRateMonitor';

const HEART_ZONE_COLORS = ['#10B981', '#3B82F6', '#F59E0B', '#F97316', '#EF4444'];

export default function App() {
  const [heartRate, setHeartRate] = useState(null);
  const [connectionState, setConnectionState] = useState('idle');
  const [deviceName, setDeviceName] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const pulse = useRef(new Animated.Value(1)).current;
  const bluetoothRef = useRef(null);

  // 主流程
  useEffect(() => {
    bluetoothRef.current = new BluetoothHeartRateMonitor({
      onConnectionStateChange: setConnectionState,
      onScanningChange: setIsScanning,
      onDeviceNameChange: setDeviceName,
      onHeartRate: setHeartRate,
    });

    bluetoothRef.current.start();

    // 清理函数
    return () => {
      (async () => {
        await bluetoothRef.current?.destroy();
        bluetoothRef.current = null;
      })();
    };
  }, []);

  // 重新扫描
  const handleRescan = async () => {
    await bluetoothRef.current?.rescan();
  };

  useEffect(() => {
    if (isFullScreen) {
      activateKeepAwake('heart-monitor');
    } else {
      deactivateKeepAwake('heart-monitor');
    }
  }, [isFullScreen]);

  useEffect(() => {
    const bpm = heartRate ?? 60;
    const duration = Math.min(2000, Math.max(300, Math.round(60000 / bpm)));
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.15,
          duration: Math.round(duration * 0.4),
          useNativeDriver: false,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: Math.round(duration * 0.6),
          useNativeDriver: false,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [heartRate, pulse]);

  const zoneIndex = useMemo(() => {
    if (heartRate === null) {
      return 0;
    }
    if (heartRate < 70) {
      return 0;
    }
    if (heartRate < 120) {
      return 1;
    }
    if (heartRate < 160) {
      return 2;
    }
    if (heartRate < 180) {
      return 3;
    }
    return 4;
  }, [heartRate]);

  const statusText = useMemo(() => {
    switch (connectionState) {
      case 'scanning':
        return '扫描中';
      case 'connecting':
        return '连接中';
      case 'connected':
        return '已连接';
      case 'no_device':
        return '未找到设备';
      case 'permission_denied':
        return '权限不足';
      case 'bluetooth_off':
        return '蓝牙未开启';
      case 'scan_error':
        return '扫描失败';
      case 'connect_error':
        return '连接失败';
      case 'monitor_error':
        return '连接中断';
      case 'disconnected':
        return '连接断开';
      default:
        return '准备中';
    }
  }, [connectionState]);

  const heartColor = HEART_ZONE_COLORS[zoneIndex];

  if (isFullScreen) {
    return (
      <Pressable style={styles.fullscreen} onPress={() => setIsFullScreen(false)}>
        <StatusBar style="light" hidden />
        <Animated.Text
          style={[
            styles.fullscreenHeart,
            { color: heartColor, transform: [{ scale: pulse }] },
          ]}
        >
          ❤
        </Animated.Text>
        <Text style={styles.fullscreenRate}>{heartRate ?? '--'}</Text>
        <Text style={styles.fullscreenUnit}>BPM</Text>
      </Pressable>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="dark" hidden={false} />
      <View style={styles.header}>
        <Text style={styles.title}>Heart Monitor</Text>
        <View style={styles.statusRow}>
          <Text style={styles.statusText}>{statusText}</Text>
          {isScanning ? <ActivityIndicator size="small" color="#3B82F6" /> : null}
        </View>
        {deviceName ? <Text style={styles.deviceText}>{deviceName}</Text> : null}
      </View>
      <View style={styles.center}>
        <Animated.Text
          style={[styles.heartIcon, { color: heartColor, transform: [{ scale: pulse }] }]}
        >
          ❤
        </Animated.Text>
        <Text style={styles.rateValue}>{heartRate ?? '--'}</Text>
        <Text style={styles.rateUnit}>BPM</Text>
      </View>
      <View style={styles.footer}>
        <Pressable style={styles.primaryButton} onPress={() => setIsFullScreen(true)}>
          <Text style={styles.primaryButtonText}>全屏</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={handleRescan}>
          <Text style={styles.secondaryButtonText}>重新扫描</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  header: {
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 6,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0F172A',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  statusText: {
    fontSize: 14,
    color: '#475569',
  },
  deviceText: {
    fontSize: 13,
    color: '#64748B',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  heartIcon: {
    fontSize: 72,
  },
  rateValue: {
    fontSize: 64,
    fontWeight: '700',
    color: '#0F172A',
  },
  rateUnit: {
    fontSize: 16,
    color: '#64748B',
    letterSpacing: 2,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 28,
    gap: 12,
  },
  primaryButton: {
    backgroundColor: '#0F172A',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#F8FAFC',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#E2E8F0',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  secondaryButtonText: {
    color: '#0F172A',
    fontSize: 16,
    fontWeight: '600',
  },
  fullscreen: {
    flex: 1,
    backgroundColor: '#0B1120',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullscreenHeart: {
    fontSize: 120,
  },
  fullscreenRate: {
    marginTop: 12,
    fontSize: 96,
    fontWeight: '700',
    color: '#F8FAFC',
  },
  fullscreenUnit: {
    fontSize: 20,
    color: '#CBD5F5',
    letterSpacing: 3,
  },
});
