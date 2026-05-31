import {
  View, Text, ScrollView, TextInput,
  StyleSheet, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { useState, useEffect } from 'react';
import { useStore } from '../../../store';
import { AuroraBackground, LiquidButton } from '../../../components/ui';
import { Glass, Brand, Text as TText, Font, Radius } from '../../../utils/theme';

type Field = {
  key: keyof Fields;
  label: string;
  placeholder: string;
  multiline?: boolean;
};

type Fields = {
  personaName: string;
  niche: string;
  personaBio: string;
  personaTone: string;
  taboos: string;
};

const FIELDS: Field[] = [
  { key: 'personaName', label: '人设名称', placeholder: '如：虾薯' },
  { key: 'niche',       label: '内容赛道', placeholder: '家居软装/出租屋改造' },
  { key: 'personaBio',  label: '账号简介', placeholder: '一句话介绍自己', multiline: true },
  { key: 'personaTone', label: '语气风格', placeholder: '嘴硬傲娇，短句换行，先吐槽再给结论', multiline: true },
  { key: 'taboos',      label: '禁忌词',   placeholder: '精致、高品质、高级感（逗号分隔）' },
];

export default function PersonaScreen() {
  const profile = useStore((s) => s.profile);
  const updateProfile = useStore((s) => s.updateProfile);

  const [fields, setFields] = useState<Fields>({
    personaName: profile?.personaName ?? '',
    niche:       profile?.niche ?? '家居软装/出租屋改造',
    personaBio:  profile?.personaBio ?? '',
    personaTone: profile?.personaTone ?? '',
    taboos:      profile?.taboos ? JSON.parse(profile.taboos).join('、') : '',
  });

  useEffect(() => {
    if (profile) {
      setFields({
        personaName: profile.personaName ?? '',
        niche:       profile.niche ?? '家居软装/出租屋改造',
        personaBio:  profile.personaBio ?? '',
        personaTone: profile.personaTone ?? '',
        taboos:      profile.taboos ? JSON.parse(profile.taboos).join('、') : '',
      });
    }
  }, [profile?.updatedAt]);

  function set(key: keyof Fields, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
  }

  async function handleSave() {
    const tabooArray = fields.taboos
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    await updateProfile({
      personaName: fields.personaName,
      niche:       fields.niche,
      personaBio:  fields.personaBio,
      personaTone: fields.personaTone,
      taboos:      JSON.stringify(tabooArray),
    });
    Alert.alert('保存成功', '人设信息已更新');
  }

  return (
    <AuroraBackground style={{ flex: 1 }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={88}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.hint}>
            人设信息用于 AI 生成符合你风格的小红书内容，不会上传服务器。
          </Text>

          {/* 字段卡 */}
          <View style={styles.card}>
            {FIELDS.map((f, i) => (
              <View key={f.key}>
                {i > 0 && <View style={styles.divider} />}
                <View style={styles.fieldRow}>
                  <Text style={styles.fieldLabel}>{f.label}</Text>
                  <TextInput
                    style={[styles.fieldInput, f.multiline && styles.fieldInputMulti]}
                    value={fields[f.key]}
                    onChangeText={(v) => set(f.key, v)}
                    placeholder={f.placeholder}
                    placeholderTextColor={TText.tertiary}
                    multiline={f.multiline}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType={f.multiline ? 'default' : 'next'}
                  />
                </View>
              </View>
            ))}
          </View>

          <LiquidButton
            label="保存人设"
            onPress={handleSave}
            style={{ marginTop: 8 }}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </AuroraBackground>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12 },

  hint: {
    fontSize: Font.footnote,
    color: TText.secondary,
    lineHeight: 18,
    paddingHorizontal: 4,
  },

  card: {
    backgroundColor: '#fff',
    borderRadius: Radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: Glass.border,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 4,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Glass.borderSubtle,
    marginLeft: 16,
  },
  fieldRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 4 },
  fieldLabel: {
    fontSize: Font.caption,
    color: TText.tertiary,
    fontWeight: Font.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldInput: {
    fontSize: Font.body,
    color: TText.primary,
    paddingTop: 2,
    minHeight: 28,
  },
  fieldInputMulti: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
});
